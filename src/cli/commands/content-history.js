#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderContentHistory } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const id = args.positionals[0] || (args.flags.id ? String(args.flags.id) : '');

  if (args.help || !id) {
    writeOutput(theme, 'Usage: npm run content:history -- <content-id> [--json]');
    if (!id && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    const history = runtime.service.history(id, { limit: args.limit ?? 50 });
    if (args.json) {
      writeJson(theme, { ok: true, history });
      return;
    }
    writeOutput(
      theme,
      renderContentHistory(history, theme, {
        timezone: runtime.config.appTimezone,
      }),
    );
  } catch (error) {
    if (args.json) {
      writeJson(theme, contentErrorPayload(error));
    } else {
      writeOutput(theme, renderError(theme, error instanceof Error ? error.message : String(error)), 'stderr');
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

main();
