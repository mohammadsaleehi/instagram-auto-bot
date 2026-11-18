#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage: npm run media:list [--json]',
        'Lists Story media files in the pending inbox only.',
        'Never selects a file for publishing — use story:publish with an exact name.',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    const ready = await runtime.storyMediaInbox.exists();
    if (!ready) {
      const message =
        `Pending inbox not found at ${runtime.storyMediaInbox.pendingDir}. Run: npm run media:init`;
      if (args.json) {
        writeJson(theme, { ok: false, error: { message, code: 'INBOX_MISSING' } });
      } else {
        writeOutput(theme, renderError(theme, message), 'stderr');
      }
      process.exitCode = 1;
      return;
    }

    const files = await runtime.storyMediaInbox.listPending();
    if (args.json) {
      writeJson(theme, {
        ok: true,
        pendingDir: runtime.storyMediaInbox.pendingDir,
        files,
      });
      return;
    }

    if (files.length === 0) {
      writeOutput(
        theme,
        `No pending Story media in ${runtime.storyMediaInbox.pendingDir}`,
      );
      return;
    }

    const lines = [
      `Pending Story media (${files.length}) — ${runtime.storyMediaInbox.pendingDir}`,
      '',
      ...files.map((file) => {
        const dims =
          file.width && file.height ? `${file.width}x${file.height}` : 'dims?';
        const status = file.valid ? 'ok' : `INVALID: ${file.error}`;
        return `  ${file.fileName}\t${file.mimeType}\t${file.byteSize}B\t${dims}\t${status}`;
      }),
    ];
    writeOutput(theme, lines.join('\n'));
  } catch (error) {
    if (args.json) {
      writeJson(theme, contentErrorPayload(error));
    } else {
      writeOutput(
        theme,
        renderError(theme, error instanceof Error ? error.message : String(error)),
        'stderr',
      );
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

main();
