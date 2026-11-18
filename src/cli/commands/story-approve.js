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
    writeOutput(
      theme,
      [
        'Usage: npm run story:approve -- <story-id> [--actor=name] [--note="..."] [--reject] [--json]',
      ].join('\n'),
    );
    if (!id && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    runtime.service.requireStory(id);
    const options = {
      actor: args.flags.actor ? String(args.flags.actor) : 'operator',
      note: args.flags.note ? String(args.flags.note) : '',
    };
    const item = args.flags.reject
      ? runtime.service.reject(id, options)
      : runtime.service.approve(id, options);

    if (args.json) {
      writeJson(theme, { ok: true, item });
      return;
    }
    writeOutput(
      theme,
      renderContentDetail(item, theme, { timezone: runtime.config.appTimezone }),
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
