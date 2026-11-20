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
import { PublicationConsistencyAuditor } from '../../modules/content/publishing/publication-consistency-auditor.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const operationId =
    args.positionals[0] || (args.flags.operation ? String(args.flags.operation) : '');
  const staleTaskMs = args.flags.staleTaskMs
    ? Number(args.flags.staleTaskMs)
    : 60_000;

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage:',
        '  npm run publication:audit [--json]',
        '  npm run publication:audit -- --operation=<id> [--json]',
        '',
        'Read-only consistency audit of durable publication operations, content,',
        'history, lifecycle events, and task state.',
        '',
        'This command NEVER opens Instagram, clicks Share, or modifies records.',
        'Exit code 1 means at least one critical inconsistency was found.',
        '',
        'Options:',
        '  --operation=<id>       Audit one operation',
        '  --stale-task-ms=<n>    Stale task threshold (default 60000)',
        '  --json                 Structured output',
      ].join('\n'),
    );
    return;
  }

  const runtime = openContentRuntime();
  try {
    const auditor = new PublicationConsistencyAuditor({
      database: runtime.database,
      repository: runtime.repository,
      nowFn: () => new Date(),
    });
    const result = auditor.audit({
      operationId: operationId || null,
      staleTaskMs,
    });

    if (args.json) {
      writeJson(theme, result);
      if (!result.ok || (operationId && result.summary.operations === 0)) {
        process.exitCode = 1;
      }
      return;
    }

    const lines = [
      'Publication consistency audit',
      `Operations inspected: ${result.summary.operations}`,
      `Consistent operations: ${result.summary.consistent}`,
      `Critical issues: ${result.summary.critical}`,
      `Warnings: ${result.summary.warnings}`,
      `Info: ${result.summary.info}`,
      '',
    ];

    if (operationId && result.summary.operations === 0) {
      lines.push(`Operation not found: ${operationId}`);
      process.exitCode = 1;
    } else if (result.issues.length === 0) {
      lines.push('No inconsistencies found.');
    } else {
      for (const issue of result.issues) {
        lines.push(`[${issue.severity.toUpperCase()}] ${issue.code}`);
        if (issue.operationId) lines.push(`  Operation: ${issue.operationId}`);
        if (issue.contentId) lines.push(`  Content: ${issue.contentId}`);
        if (issue.taskId) lines.push(`  Task: ${issue.taskId}`);
        if (issue.accountId) lines.push(`  Account: ${issue.accountId}`);
        lines.push(`  Problem: ${issue.problem}`);
        lines.push(`  Expected: ${JSON.stringify(issue.expected)}`);
        lines.push(`  Actual: ${JSON.stringify(issue.actual)}`);
        lines.push(`  Recovery: ${issue.suggestedAction}`);
        lines.push('');
      }
    }

    lines.push('No Instagram action was performed.');
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
