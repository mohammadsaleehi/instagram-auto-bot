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
  const selector = args.positionals[0] || '';

  if (args.help || !selector) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:publish -- <filename> --confirm [--dry-run] [--json]',
        '  npm run story:publish -- ./media/stories/pending/story-01.jpg --confirm',
        '',
        'Publishes exactly one Story image via the configured publishing adapter.',
        'Requires an explicit filename/path (never auto-picks media).',
        'Real browser publishes need:',
        '  PUBLISHING_ADAPTER=playwright',
        '  CONTENT_DRY_RUN=false',
        '  npm start (engine running with an authenticated session)',
        '  --confirm',
        '',
        'Default path enqueues content.publish (maxAttempts=1). Use --inline only with mock/dry-run.',
      ].join('\n'),
    );
    if (!selector && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    const dryRun =
      args.flags.dryRun === undefined
        ? runtime.config.contentDryRun
        : Boolean(args.flags.dryRun);
    const confirm = Boolean(args.flags.confirm) || dryRun;
    const adapterName = runtime.adapter.getCapabilities().name;
    const inline = args.flags.inline === true || args.flags.enqueue === false;

    if (inline && adapterName === 'playwright' && !dryRun) {
      throw new Error(
        'Inline real Playwright Story publish from CLI is not supported. Start npm start and omit --inline so the engine worker performs the publish.',
      );
    }

    const result = await runtime.service.publishStoryFromMedia(selector, {
      confirm,
      dryRun,
      enqueue: !inline,
      title: args.flags.title ? String(args.flags.title) : undefined,
      actor: args.flags.actor ? String(args.flags.actor) : 'operator',
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
          [
            `Prepared Story ${result.content?.id} from ${result.media?.fileName}`,
            `Enqueued content.publish task ${result.task?.id}${dryRun ? ' (dry-run)' : ''}`,
            result.duplicate ? 'Note: duplicate idempotency key — existing task reused' : null,
            'Inspect with: npm run story:status',
            'Jobs: npm run jobs',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
      return;
    }

    writeOutput(
      theme,
      renderSuccess(
        theme,
        [
          `Story publish finished: ${result.content?.status}`,
          result.attempt
            ? `Attempt: ${result.attempt.status} via ${result.attempt.adapter}`
            : null,
          result.simulated ? 'Simulated / dry-run — not a real Instagram publication' : null,
          result.duplicate ? 'Duplicate publish prevented' : null,
        ]
          .filter(Boolean)
          .join('\n'),
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
