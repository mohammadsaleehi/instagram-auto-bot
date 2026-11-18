#!/usr/bin/env node
import { createControlClient, ControlClientError } from '../../ipc/control-client.js';
import { loadConfig } from '../../config/config.js';
import {
  createTheme,
  installSqliteWarningFilter,
  parseCliArgs,
  renderControlError,
  renderResumeResult,
  writeJson,
  writeOutput,
} from '../ui/index.js';

installSqliteWarningFilter();

async function main() {
  const args = parseCliArgs();
  const theme = createTheme();

  try {
    const config = loadConfig();
    const client = createControlClient({
      socketPath: config.controlSocketPath,
      tokenPath: config.controlTokenPath,
    });
    const result = await client.resume();

    if (args.json) {
      writeJson(theme, result);
      return;
    }

    writeOutput(theme, renderResumeResult(result, theme));
    if (!result?.resumed) {
      process.exitCode = 1;
    }
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
