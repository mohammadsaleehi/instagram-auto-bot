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

    lines.push(`Latest Story: ${content?.id ?? 'n/a'} (${content?.title ?? ''})`);
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
    if (attempt.result?.message) {
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

main();
