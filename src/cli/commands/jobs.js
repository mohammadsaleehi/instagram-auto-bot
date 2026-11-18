#!/usr/bin/env node
import { createControlClient, ControlClientError } from '../../ipc/control-client.js';
import { loadConfig } from '../../config/config.js';
import {
  createTheme,
  installSqliteWarningFilter,
  parseCliArgs,
  renderControlError,
  renderJobsReport,
  writeJson,
  writeOutput,
} from '../ui/index.js';

installSqliteWarningFilter();

async function main() {
  const args = parseCliArgs();
  const theme = createTheme();
  const limit = args.limit ?? 20;

  try {
    const config = loadConfig();
    const client = createControlClient({
      socketPath: config.controlSocketPath,
      tokenPath: config.controlTokenPath,
    });
    const result = await client.jobs({ limit });

    if (args.json) {
      writeJson(theme, result);
      return;
    }

    writeOutput(
      theme,
      renderJobsReport(result, theme, {
        timezone: config.appTimezone,
        verbose: args.verbose,
        limit,
      }),
    );
  } catch (error) {
    if (error instanceof ControlClientError) {
      if (args.json) {
        writeJson(theme, {
          ok: false,
          error: { message: error.message, code: error.code },
        });
      } else {
        writeOutput(theme, renderControlError(error, theme), 'stderr');
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();
