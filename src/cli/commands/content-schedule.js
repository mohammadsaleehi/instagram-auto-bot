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
import { renderContentDetail } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const id = args.positionals[0] || (args.flags.id ? String(args.flags.id) : '');
  const when =
    args.positionals[1] ||
    (args.flags.at ? String(args.flags.at) : '') ||
    (args.flags.when ? String(args.flags.when) : '');

  if (args.help || !id) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run content:schedule -- <content-id> --at="2026-11-11T10:00:00+01:00" [--dry-run] [--json]',
        '  npm run content:schedule -- <content-id> --now --confirm [--dry-run] [--inline] [--json]',
        '  npm run content:schedule -- <content-id> --reschedule --at="..." [--json]',
      ].join('\n'),
    );
    if (!id && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    if (args.flags.now) {
      const dryRun =
        args.flags.dryRun === undefined
          ? runtime.config.contentDryRun
          : Boolean(args.flags.dryRun);
      const result = await runtime.service.publishNow(id, {
        dryRun,
        confirm: Boolean(args.flags.confirm) || dryRun,
        enqueue: args.flags.enqueue !== false,
      });
      if (args.json) {
        writeJson(theme, { ok: true, result });
        return;
      }
      if (result.enqueued) {
        writeOutput(
          theme,
          renderSuccess(theme, 
            `Enqueued content.publish task ${result.task.id}${dryRun ? ' (dry-run)' : ''}`,
          ),
        );
      } else {
        writeOutput(
          theme,
          renderSuccess(theme, 
            `Publish ${result.content?.status}${result.simulated ? ' (simulated)' : ''}`,
          ),
        );
      }
      return;
    }

    if (!when) {
      throw new Error('Provide --at=<ISO-8601 datetime> or --now');
    }

    const dryRun =
      args.flags.dryRun === undefined
        ? runtime.config.contentDryRun
        : Boolean(args.flags.dryRun);

    const item = args.flags.reschedule
      ? runtime.service.reschedule(id, when, { dryRun })
      : runtime.service.schedule(id, when, { dryRun });

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
      writeOutput(theme, renderError(theme, error instanceof Error ? error.message : String(error)), 'stderr');
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

main();
