#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';
import { PublicationLifecycleService } from '../../modules/content/publishing/publication-lifecycle.js';

installSqliteWarningFilter();

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const operationId =
    args.positionals[0] || (args.flags.operation ? String(args.flags.operation) : '');

  if (args.help || !operationId) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:operation -- --operation=<id> [--json]',
        '  npm run story:operation -- <id> [--json]',
        '',
        'Read-only inspection of one durable Story operation, its content, history, and audit events.',
        'No Instagram action is performed.',
      ].join('\n'),
    );
    if (!operationId && !args.help) process.exitCode = 1;
    return;
  }

  const runtime = openContentRuntime();
  try {
    const operation = runtime.database.raw
      .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
      .get(operationId);
    if (!operation) {
      throw new Error(`Story operation not found: ${operationId}`);
    }
    const content = runtime.repository.getById(String(operation.content_id));
    const history = runtime.database.raw
      .prepare(
        `SELECT * FROM publishing_history
         WHERE content_id = ? AND request_id = ?
         ORDER BY created_at ASC`,
      )
      .all(String(operation.content_id), operationId);
    const events = runtime.database.raw
      .prepare(
        `SELECT * FROM story_operation_events
         WHERE operation_id = ?
         ORDER BY at ASC`,
      )
      .all(operationId);
    const evidence = parseJson(operation.evidence_json, {}) ?? {};
    const verification =
      evidence.independentVerification ?? evidence.verification ?? null;
    const observed = evidence.observed ?? null;
    const lifecycle = new PublicationLifecycleService({
      database: runtime.database,
      repository: runtime.repository,
    });
    const publication = lifecycle.getPublicationState({
      operationId: operation.id,
      contentId: operation.content_id,
    });
    const lifecycleEvents = runtime.database.raw
      .prepare(
        `SELECT * FROM publication_lifecycle_events
         WHERE operation_id = ? ORDER BY at ASC`,
      )
      .all(operationId);

    if (args.json) {
      writeJson(theme, {
        ok: true,
        operation: {
          ...operation,
          evidence,
        },
        publicationState: publication,
        content,
        history: history.map((row) => ({
          ...row,
          result: parseJson(row.result_json, null),
          error: parseJson(row.error_json, null),
        })),
        lifecycleEvents: lifecycleEvents.map((row) => ({
          ...row,
          evidence: parseJson(row.evidence_json, null),
        })),
        events: events.map((row) => ({
          ...row,
          evidence: parseJson(row.evidence_json, null),
        })),
      });
      return;
    }

    const lines = [
      `Operation: ${operation.id}`,
      `Execution state: ${operation.state}`,
      `Publication outcome: ${publication.outcome ?? 'unknown'} (source: ${publication.source})`,
      `Account: ${publication.accountId ?? 'n/a'}`,
      `Retryable (canonical): ${publication.retryable ? 'yes' : 'no'}`,
      `Recovery: ${recoveryRecommendation(publication)}`,
      `Last transition: ${
        lifecycleEvents.length
          ? `${lifecycleEvents[lifecycleEvents.length - 1].event} ${lifecycleEvents[lifecycleEvents.length - 1].previous_outcome ?? '—'}→${lifecycleEvents[lifecycleEvents.length - 1].new_outcome ?? '—'} at ${lifecycleEvents[lifecycleEvents.length - 1].at}`
          : 'n/a'
      }`,
      ...(publication.contradictions.length
        ? [
            `Consistency warnings: ${publication.contradictions
              .map((item) => item.code)
              .join(', ')}`,
          ]
        : []),
      `Failure: ${operation.failure_code ?? 'none'}`,
      `Operation retryable flag: ${operation.retryable ? 'yes' : 'no'}`,
      `Created: ${operation.created_at}`,
      `Completed: ${operation.completed_at ?? 'n/a'}`,
      `Share intent: ${operation.share_intent_at ?? 'n/a'}`,
      `Share click: ${operation.share_clicked_at ?? 'n/a'}`,
      `Share result: ${operation.share_click_result ?? 'n/a'}`,
      `Reconciled at: ${operation.reconciled_at ?? 'n/a'}`,
      `Reconciled by: ${operation.reconciled_by ?? 'n/a'}`,
      `Previous state: ${operation.previous_state ?? 'n/a'}`,
      `Previous failure: ${operation.previous_failure_code ?? 'n/a'}`,
      `Content: ${content?.id ?? 'n/a'} (${content?.status ?? 'n/a'})`,
      `Published at: ${content?.publishedAt ?? 'n/a'}`,
      `External publish id: ${content?.externalPublishId ?? 'n/a'}`,
      `Last error: ${content?.lastError ?? 'n/a'}`,
      `Story published: ${content?.story?.storyPublishedAt ?? 'n/a'}`,
      `Story expires: ${content?.story?.storyExpiresAt ?? 'n/a'}`,
      `Story container: ${content?.story?.storyContainerId ?? 'n/a'}`,
      `Verification viewer: ${verification?.viewerUrl ?? 'n/a'}`,
      `Verification identity: ${verification?.identity?.distance ?? 'n/a'}`,
      `Verification time: ${(verification?.timeLabels ?? []).join(', ') || 'n/a'}`,
      `Editor closed: ${observed?.leftEditor ?? 'n/a'}`,
      '',
      'History:',
      ...history.map(
        (row) =>
          `  ${row.created_at} attempt=${row.attempt_number} status=${row.status} dry=${row.dry_run} request=${row.request_id ?? 'n/a'}`,
      ),
      '',
      'Lifecycle events:',
      ...(lifecycleEvents.length
        ? lifecycleEvents.map(
            (row) =>
              `  ${row.at} ${row.event} ${row.previous_outcome ?? '—'}→${row.new_outcome ?? '—'} by ${row.actor}${row.reason ? `: ${row.reason}` : ''}`,
          )
        : ['  (none)']),
      '',
      'Reconciliation events:',
      ...(events.length
        ? events.map(
            (row) =>
              `  ${row.at} ${row.event} ${row.previous_state ?? ''}→${row.new_state ?? ''} by ${row.actor}${row.reason ? `: ${row.reason}` : ''}`,
          )
        : ['  (none)']),
    ];
    writeOutput(theme, lines.join('\n'));
  } catch (error) {
    if (args.json) {
      writeJson(theme, contentErrorPayload(error));
    } else {
      writeOutput(theme, `Error: ${error instanceof Error ? error.message : String(error)}`, 'stderr');
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

function recoveryRecommendation(publication) {
  switch (publication.outcome) {
    case 'PUBLICATION_CONFIRMED':
      return 'None. Do not republish this Story.';
    case 'PUBLICATION_UNCERTAIN':
      return 'Inspect the account read-only. Reconcile only with verified evidence; never retry automatically.';
    case 'PUBLISH_FAILED':
      return publication.retryable
        ? 'A new safe attempt may be authorized; the failed operation itself must not be retried automatically.'
        : 'Do not retry automatically. Inspect diagnostics and authorization.';
    case 'CANCELLED':
      return 'Cancelled before Share. Create a new attempt only with explicit authorization.';
    case 'READY':
      return 'Ready for an explicitly authorized publication.';
    case 'PENDING':
    case 'VALIDATING':
      return 'Operation is still preparing.';
    case 'PUBLISHING':
      return 'Publication is in progress. Do not start another operation.';
    default:
      return 'Inspect the operation; no canonical publication outcome is available.';
  }
}

main();
