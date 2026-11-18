#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createControlClient, ControlClientError } from '../../ipc/control-client.js';
import { loadConfig, ConfigError } from '../../config/config.js';
import { Database } from '../../storage/database.js';
import { DEMO_TASK_TYPE } from '../../tasks/constants.js';
import {
  detectSystemBrowserExecutable,
  SYSTEM_BROWSER_CANDIDATES,
} from '../../browser/browser-manager.js';
import {
  createTheme,
  doctorExitCode,
  installSqliteWarningFilter,
  parseCliArgs,
  redactSensitive,
  renderDoctorReport,
  writeJson,
  writeOutput,
} from '../ui/index.js';

installSqliteWarningFilter();

/**
 * Doctor works even when the bot is offline by validating local artifacts.
 * When the bot is running, it also merges live runtime diagnostics.
 */
async function main() {
  const args = parseCliArgs();
  const theme = createTheme();
  /** @type {object[]} */
  const checks = [];

  checks.push({
    name: 'node',
    ok: true,
    detail: {
      version: process.versions.node,
      sqlite: process.versions.sqlite ?? 'unknown',
      note: `Node.js ${process.versions.node} (node:sqlite is experimental in this Node release)`,
    },
  });

  let config;
  try {
    config = loadConfig();
    checks.push({
      name: 'config',
      ok: true,
      detail: {
        browserMode: config.browserMode,
        timezone: config.appTimezone,
        workerConcurrency: config.workerConcurrency,
        databasePath: path.basename(config.databasePath),
      },
    });
  } catch (error) {
    checks.push({
      name: 'config',
      ok: false,
      detail: error instanceof ConfigError ? error.message : String(error),
    });
    return finish({ ok: false, checks }, theme, args);
  }

  try {
    const database = new Database({ filePath: config.databasePath });
    database.open();
    const integrity = database.checkIntegrity();
    checks.push({
      name: 'database',
      ok: integrity.ok,
      detail: {
        path: path.basename(config.databasePath),
        schemaVersion: database.getSchemaVersion(),
        integrity: integrity.detail,
      },
    });
    database.close();
  } catch (error) {
    checks.push({
      name: 'database',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const authExists = fs.existsSync(config.authStorageStatePath);
  checks.push({
    name: 'session_file',
    ok: config.browserMode === 'storage-state' ? authExists : true,
    detail: {
      path: path.basename(config.authStorageStatePath),
      present: authExists,
      requiredForMode: config.browserMode === 'storage-state',
      note:
        config.browserMode === 'storage-state'
          ? authExists
            ? 'storage-state file present (contents not read)'
            : 'missing — run npm run login and transfer securely'
          : 'not required for current browser mode',
    },
  });

  const browserPath = detectSystemBrowserExecutable({
    configuredPath: config.browserExecutablePath,
    candidates: SYSTEM_BROWSER_CANDIDATES,
  });
  checks.push({
    name: 'browser_availability',
    ok:
      config.browserMode === 'existing'
        ? true
        : Boolean(browserPath || config.browserChannel),
    detail: {
      mode: config.browserMode,
      executableDetected: Boolean(browserPath),
      channel: config.browserChannel,
      note:
        config.browserMode === 'existing'
          ? 'existing mode uses CDP; enable chrome://inspect/#remote-debugging'
          : browserPath
            ? `found ${browserPath}`
            : 'no system browser detected',
    },
  });

  checks.push({
    name: 'control_socket_permissions',
    ok: true,
    detail: inspectSocketPermissions(config.controlSocketPath),
  });

  const realGraph =
    config.publishingAdapter === 'instagram-graph' && config.contentDryRun === false;
  checks.push({
    name: 'publishing',
    ok: !realGraph || Boolean(config.instagramGraphAccessToken && config.instagramBusinessAccountId),
    detail: {
      adapter: config.publishingAdapter,
      contentDryRun: config.contentDryRun,
      loginFlow: config.instagramGraphLoginFlow,
      hasGraphToken: Boolean(config.instagramGraphAccessToken),
      hasIgUserId: Boolean(config.instagramBusinessAccountId),
      mediaPublicBaseUrl: config.mediaPublicBaseUrl ? '(set)' : null,
      note: realGraph
        ? config.mediaPublicBaseUrl
          ? 'Real Graph publishing enabled — ensure MEDIA_PUBLIC_BASE_URL serves the media library over HTTPS'
          : 'Real Graph publishing enabled but MEDIA_PUBLIC_BASE_URL is missing (required for Stories/media URLs)'
        : 'Safe defaults: mock adapter and/or CONTENT_DRY_RUN=true',
    },
  });
  if (realGraph && !config.mediaPublicBaseUrl) {
    checks[checks.length - 1].ok = false;
  }

  try {
    const client = createControlClient({
      socketPath: config.controlSocketPath,
      tokenPath: config.controlTokenPath,
    });
    const live = await client.doctor();
    checks.push({
      name: 'runtime',
      ok: Boolean(live?.ok),
      detail: {
        running: true,
        handlers:
          live?.checks?.find((c) => c.name === 'handlers')?.detail ?? [
            DEMO_TASK_TYPE,
          ],
        note: 'Bot runtime is reachable',
      },
    });

    const authCheck = live?.checks?.find((c) => c.name === 'authentication');
    if (authCheck) {
      checks.push({
        name: 'authentication',
        ok: Boolean(authCheck.ok),
        detail: redactSensitive(authCheck.detail),
      });
    }
    const browserCheck = live?.checks?.find((c) => c.name === 'browser');
    if (browserCheck) {
      checks.push({
        name: 'browser',
        ok: Boolean(browserCheck.ok),
        detail: redactSensitive(browserCheck.detail),
      });
    }
  } catch (error) {
    checks.push({
      name: 'runtime',
      ok: true,
      detail: {
        running: false,
        note:
          error instanceof ControlClientError
            ? error.message
            : 'Bot is not running (offline doctor only)',
      },
    });
  }

  const ok = checks.every((check) => check.ok);
  return finish({ ok, checks }, theme, args);
}

/**
 * @param {string} socketPath
 */
function inspectSocketPermissions(socketPath) {
  if (!fs.existsSync(socketPath)) {
    return {
      present: false,
      note: 'Socket absent (bot not running) — OK for offline doctor',
    };
  }
  const stat = fs.statSync(socketPath);
  const mode = stat.mode & 0o777;
  const secure = (mode & 0o077) === 0;
  return {
    present: true,
    mode: mode.toString(8),
    secure,
    note: secure
      ? 'Socket restricted to the current user'
      : 'WARNING: socket is group/world accessible',
  };
}

/**
 * @param {{ ok: boolean, checks: object[] }} report
 * @param {import('../ui/theme.js').Theme} theme
 * @param {{ json: boolean }} args
 */
function finish(report, theme, args) {
  const safeReport = {
    ok: report.ok,
    checks: redactSensitive(report.checks),
  };

  if (args.json) {
    writeJson(theme, safeReport);
  } else {
    writeOutput(theme, renderDoctorReport(safeReport, theme));
  }

  process.exitCode = doctorExitCode(safeReport);
}

main();
