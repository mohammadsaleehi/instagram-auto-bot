#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderContentList, renderContentCalendar } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage: npm run content:list [--status=DRAFT] [--type=IMAGE] [--query=text] [--calendar] [--json]',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    if (args.flags.calendar) {
      const calendar = runtime.service.listCalendar({ limit: args.limit ?? 50 });
      if (args.json) {
        writeJson(theme, { ok: true, calendar });
        return;
      }
      writeOutput(
        theme,
        renderContentCalendar(calendar, theme, {
          timezone: runtime.config.appTimezone,
        }),
      );
      return;
    }

    const items = runtime.service.list({
      status: args.flags.status ? String(args.flags.status) : undefined,
      contentType: args.flags.type ? String(args.flags.type) : undefined,
      query: args.flags.query ? String(args.flags.query) : undefined,
      limit: args.limit ?? 50,
    });

    if (args.json) {
      writeJson(theme, { ok: true, items });
      return;
    }

    writeOutput(
      theme,
      renderContentList(items, theme, { timezone: runtime.config.appTimezone }),
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
