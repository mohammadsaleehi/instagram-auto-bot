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
import { PublicationLifecycleService } from '../../modules/content/publishing/publication-lifecycle.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const contentId = args.positionals[0] || (args.flags.id ? String(args.flags.id) : '');

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run story:status [--json]',
        '  npm run story:status -- <story-id> [--json]',
        'Shows the latest Story publication attempt and content status.',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    const status = runtime.service.latestStoryPublicationStatus({
      contentId: contentId || undefined,
      limit: args.limit ?? 5,
    });

    if (args.json) {
      writeJson(theme, {
        ok: true,
        adapter: runtime.adapter.getCapabilities().name,
        dryRunDefault: runtime.config.contentDryRun,
        storyMediaDir: runtime.config.storyMediaDir,
        ...status,
      });
      return;
    }

    const caps = runtime.adapter.getCapabilities();
    const lines = [
      `Publishing adapter: ${caps.name}${caps.isMock ? ' (mock)' : ''}`,
      `CONTENT_DRY_RUN default: ${runtime.config.contentDryRun}`,
      `Story media dir: ${runtime.config.storyMediaDir}`,
      '',
    ];

    if (!status.latest) {
      lines.push('No Story publication attempts recorded yet.');
      writeOutput(theme, lines.join('\n'));
      return;
    }

    const content = status.latest.content ?? status.content;
    const attempt = status.latest.attempt;
    const lifecycle = new PublicationLifecycleService({
      database: runtime.database,
      repository: runtime.repository,
    });
    const publication = lifecycle.getPublicationState({
      operationId: attempt.requestId ?? null,
      contentId: content?.id ?? null,
    });
    const lastTransition = runtime.database.raw
      .prepare(
        `SELECT * FROM publication_lifecycle_events
         WHERE (operation_id = ? OR content_id = ?)
         ORDER BY at DESC LIMIT 1`,
      )
      .get(
        publication.operation?.id ?? attempt.requestId ?? null,
        content?.id ?? null,
      );

    lines.push(`Latest Story: ${content?.id ?? 'n/a'} (${content?.title ?? ''})`);
    lines.push(`Account: ${publication.accountId ?? 'unknown'}`);
    lines.push(
      `Operation: ${publication.operation?.id ?? attempt.requestId ?? 'n/a'}`,
    );
    lines.push(
      `Publication outcome: ${publication.outcome ?? 'unknown'} (source: ${publication.source})`,
    );
    lines.push(
      `Last transition: ${
        lastTransition
          ? `${lastTransition.event} ${lastTransition.previous_outcome ?? '—'}→${lastTransition.new_outcome ?? '—'} at ${lastTransition.at}`
          : 'n/a'
      }`,
    );
    lines.push(`Share intent: ${publication.shareIntentAt ?? 'none'}`);
    lines.push(`Share click: ${publication.shareClickedAt ?? 'none'}`);
    lines.push(`Retryable: ${publication.retryable ? 'yes' : 'no'}`);
    lines.push(`Recovery: ${recoveryRecommendation(publication)}`);
    if (publication.contradictions.length) {
      lines.push(
        `Consistency warnings: ${publication.contradictions
          .map((item) => item.code)
          .join(', ')}`,
      );
    }
    lines.push(`Content status: ${content?.status ?? 'n/a'}`);
    if (content?.story?.storyPublishedAt) {
      lines.push(`Published at: ${content.story.storyPublishedAt}`);
      lines.push(`Expires at: ${content.story.storyExpiresAt ?? 'n/a'}`);
    }
    lines.push(
      `Attempt #${attempt.attemptNumber}: ${attempt.status} via ${attempt.adapter}`,
    );
    if (attempt.externalPublishId) {
      lines.push(`External id: ${attempt.externalPublishId}`);
    }
    const reconciliation = attempt.result?.reconciliation;
    if (reconciliation) {
      lines.push(
        `Reconciled: ${reconciliation.reconciledAt ?? 'n/a'} by ${reconciliation.reconciledBy ?? 'n/a'}`,
      );
      lines.push(
        `Original outcome: ${reconciliation.previousStatus ?? 'n/a'}${
          reconciliation.previousFailureCode
            ? ` (${reconciliation.previousFailureCode})`
            : ''
        }`,
      );
      lines.push('Message: Publication confirmed by independent verification and reconciliation.');
    } else if (attempt.result?.message) {
      lines.push(`Message: ${attempt.result.message}`);
    }
    if (attempt.error?.message) {
      lines.push(`Error: ${attempt.error.message}`);
    }
    if (content?.lastError) {
      lines.push(`Last error: ${content.lastError}`);
    }
    if (content?.status === 'NEEDS_ATTENTION') {
      lines.push(
        'Outcome is uncertain — verify Instagram manually. Do not blind-retry.',
      );
    }

    writeOutput(theme, lines.join('\n'));
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
