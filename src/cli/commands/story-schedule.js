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

  const group = args.flags.group ? String(args.flags.group) : '';

  if (args.help || (!id && !group)) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:schedule -- <story-id> --at="2026-11-18T10:00:00+01:00" [--dry-run] [--json]',
        '  npm run story:schedule -- --group=launch --at="2026-11-18T10:00:00+01:00" [--stagger-ms=5000]',
        '  npm run story:schedule -- <story-id> --now --confirm [--dry-run] [--inline] [--json]',
        '  npm run story:schedule -- <story-id> --reschedule --at="..." [--json]',
        `Timezone: APP_TIMEZONE (schedules stored as absolute ISO timestamps).`,
        'Group scheduling uses the existing Phase 2 scheduler (one schedule per Story, ordered by sequence).',
      ].join('\n'),
    );
    if (!id && !group && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    if (group && !id) {
      if (!when && !args.flags.now) {
        throw new Error('Provide --at=<ISO-8601 datetime> when scheduling a Story group');
      }
      if (args.flags.now) {
        throw new Error('Use --at=... for group scheduling (immediate --now is per-Story only)');
      }
      const dryRun =
        args.flags.dryRun === undefined
          ? runtime.config.contentDryRun
          : Boolean(args.flags.dryRun);
      const items = runtime.service.scheduleStoryGroup(group, when, {
        dryRun,
        staggerMs:
          args.flags.staggerMs != null ? Number(args.flags.staggerMs) : undefined,
      });
      if (args.json) {
        writeJson(theme, { ok: true, items });
        return;
      }
      writeOutput(
        theme,
        renderSuccess(
          theme,
          `Scheduled ${items.length} Stories in group "${group}" (staggered by sequence)`,
        ),
      );
      for (const item of items) {
        writeOutput(
          theme,
          renderContentDetail(item, theme, { timezone: runtime.config.appTimezone }),
        );
      }
      return;
    }

    runtime.service.requireStory(id);

    if (args.flags.now) {
      const dryRun =
        args.flags.dryRun === undefined
          ? runtime.config.contentDryRun
          : Boolean(args.flags.dryRun);
      const result = await runtime.service.publishNow(id, {
        dryRun,
        confirm: Boolean(args.flags.confirm) || dryRun,
        enqueue: args.flags.enqueue !== false && args.flags.inline !== true,
      });
      if (args.json) {
        writeJson(theme, { ok: true, result });
        return;
      }
      if (result.enqueued) {
        writeOutput(
          theme,
          renderSuccess(
            theme,
            `Enqueued content.publish task ${result.task.id}${dryRun ? ' (dry-run)' : ''}`,
          ),
        );
      } else {
        writeOutput(
          theme,
          renderSuccess(
            theme,
            `Story publish ${result.content?.status}${result.simulated ? ' (simulated)' : ''}`,
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
