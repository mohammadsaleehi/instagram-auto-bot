#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  renderSuccess,
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
        'Usage: npm run media:init [--json]',
        'Creates the Story media inbox directories (does not delete or move existing files):',
        '  media/stories/pending/',
        '  media/stories/published/',
        '  media/stories/failed/',
        'Override root with STORY_MEDIA_DIR.',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    const result = await runtime.storyMediaInbox.initialize();
    if (args.json) {
      writeJson(theme, { ok: true, inbox: result });
      return;
    }
    writeOutput(
      theme,
      renderSuccess(
        theme,
        `Story media inbox ready at ${result.rootDir}\n  pending:   ${result.pendingDir}\n  published: ${result.publishedDir}\n  failed:    ${result.failedDir}`,
      ),
    );
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
