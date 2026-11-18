#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderContentHistory, renderStoryList } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const id = args.positionals[0] || (args.flags.id ? String(args.flags.id) : '');

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:history -- <story-id> [--json]',
        '  npm run story:history [--json]   # recent Story publishing history overview',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    if (!id) {
      const items = runtime.service.listStories({
        limit: args.limit ?? 50,
      });
      if (args.json) {
        writeJson(theme, {
          ok: true,
          items: items.map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            publishedAt: item.publishedAt,
            externalPublishId: item.externalPublishId,
            story: item.story,
          })),
        });
        return;
      }
      writeOutput(
        theme,
        renderStoryList(items, theme, { timezone: runtime.config.appTimezone }),
      );
      return;
    }

    runtime.service.requireStory(id);
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
