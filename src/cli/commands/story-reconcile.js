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
import { StoryReconciliationService } from '../../modules/content/publishing/story/story-reconciliation.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const operationId =
    args.positionals[0] || (args.flags.operation ? String(args.flags.operation) : '');

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:reconcile -- --operation=<id> [--dry-run] [--json]',
        '  npm run story:reconcile -- --operation=<id> --confirm --actor=<who> --reason=<why>',
        '',
        'Reconciles one durable Story operation using its stored independent verification evidence.',
        'DESTRUCTIVE DATABASE ACTION ONLY WHEN --confirm IS PRESENT.',
        'This command never opens Instagram, never clicks Share, and never creates a new operation.',
        '',
        'Options:',
        '  --operation=<id>             Exact durable operation ID (required)',
        '  --confirm                    Write the reconciliation; without it, validates only',
        '  --actor=<who>                Audit actor (default: cli:operator)',
        '  --reason=<why>               Audit reason',
        '  --account=<handle>           Expected Instagram account handle',
        '  --media=<path>               Source media path to re-hash',
        '  --max-identity-distance=<n>  Viewer identity threshold (default 32)',
      ].join('\n'),
    );
    if (!operationId) process.exitCode = 1;
    return;
  }

  if (!operationId) {
    writeOutput(
      theme,
      'A durable Story operation ID is required. Use --operation=<id> or pass it as the first argument.',
      'stderr',
    );
    process.exitCode = 1;
    return;
  }

  const confirm = args.flags.confirm === true;
  const dryRun = !confirm;
  const actor = args.flags.actor ? String(args.flags.actor) : 'cli:operator';
  const reason = args.flags.reason
    ? String(args.flags.reason)
    : 'Independent verification evidence confirms the Story on the account.';
  const expectedAccountHandle = args.flags.account
    ? String(args.flags.account)
    : null;
  const sourceMediaPath = args.flags.media ? String(args.flags.media) : null;
  const maxIdentityDistance = args.flags.maxIdentityDistance
    ? Number(args.flags.maxIdentityDistance)
    : 32;

  const runtime = openContentRuntime();
  try {
    const service = new StoryReconciliationService({
      database: runtime.database,
      repository: runtime.repository,
    });
    const result = await service.reconcile(operationId, {
      actor,
      reason,
      expectedAccountHandle,
      sourceMediaPath,
      maxIdentityDistance,
      dryRun,
    });

    if (args.json) {
      writeJson(theme, {
        ok: result.ok,
        dryRun,
        confirmed: !dryRun && result.ok,
        ...result,
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const lines = [
      `Reconciliation: ${
        dryRun
          ? result.ok
            ? 'DRY RUN — evidence valid, no changes written'
            : 'DRY RUN — evidence NOT sufficient'
          : result.ok
            ? 'CONFIRMED'
            : 'REJECTED — no changes written'
      }`,
      `Operation: ${result.operationId}`,
      `Operation state: ${result.previousState ?? 'n/a'} → ${
        result.ok ? 'PUBLICATION_CONFIRMED' : 'unchanged'
      }`,
      `Classification: ${result.classification}`,
      `Reason: ${result.reason}`,
      `Content: ${result.contentId ?? 'n/a'}`,
      `History: ${result.historyId ?? 'n/a'}`,
      `Published at: ${result.publishedAt ?? 'n/a'}`,
      `Share intent: ${result.evidence?.shareIntentAt ?? 'n/a'}`,
      `Share click: ${result.evidence?.shareClickedAt ?? 'n/a'}`,
      `Viewer: ${result.evidence?.verification?.viewerUrl ?? 'n/a'}`,
      `Identity distance: ${result.evidence?.verification?.identity?.distance ?? 'n/a'}`,
      `Actor: ${actor}`,
      `Audit reason: ${reason}`,
      '',
      'No Instagram action was performed. This command only reads stored evidence and updates the database when --confirm is present.',
    ];

    const failed = result.checks.filter((item) => !item.ok);
    if (failed.length) {
      lines.push('', 'Failed checks:');
      for (const item of failed) {
        lines.push(`  - ${item.name}`);
      }
    }
    if (dryRun && result.ok) {
      lines.push('', 'Re-run with --confirm to write this reconciliation.');
    }
    writeOutput(theme, lines.join('\n'));
    if (!result.ok) process.exitCode = 1;
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
