#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderContentDetail } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const id = args.positionals[0] || (args.flags.id ? String(args.flags.id) : '');

  if (args.help || !id) {
    writeOutput(theme, 'Usage: npm run content:show -- <content-id> [--json]');
    if (!id && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    const preview = runtime.service.preview(id);
    if (args.json) {
      writeJson(theme, { ok: true, item: preview });
      return;
    }
    writeOutput(
      theme,
      renderContentDetail(preview, theme, {
        timezone: runtime.config.appTimezone,
        captionPreview: preview.captionPreview,
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
