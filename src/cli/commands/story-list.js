#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderStoryList } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage: npm run story:list [--status=DRAFT] [--group=campaign] [--query=text] [--expire-due] [--json]',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    /** @type {object[]} */
    let expired = [];
    if (args.flags.expireDue || args.flags['expire-due']) {
      expired = runtime.service.expireDueStories({ limit: args.limit ?? 100 });
    }

    const items = runtime.service.listStories({
      status: args.flags.status ? String(args.flags.status) : undefined,
      groupId: args.flags.group ? String(args.flags.group) : undefined,
      query: args.flags.query ? String(args.flags.query) : undefined,
      limit: args.limit ?? 50,
    });

    if (args.json) {
      writeJson(theme, { ok: true, items, expiredCount: expired.length });
      return;
    }

    if (expired.length) {
      writeOutput(
        theme,
        theme.paint(`Marked ${expired.length} published Story/Stories as EXPIRED.`, 'yellow'),
      );
    }
    writeOutput(
      theme,
      renderStoryList(items, theme, { timezone: runtime.config.appTimezone }),
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
