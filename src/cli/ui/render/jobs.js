import {
  formatDateTime,
  formatPriority,
  truncateId,
} from '../format.js';
import {
  renderBlock,
  renderEmptyState,
  renderHeavyDivider,
  renderSectionTitle,
  renderTable,
} from '../layout.js';

/**
 * @param {string} status
 */
function statusTone(status) {
  switch (String(status).toUpperCase()) {
    case 'COMPLETED':
      return 'success';
    case 'RUNNING':
      return 'running';
    case 'PENDING':
      return 'pending';
    case 'NEEDS_ATTENTION':
    case 'CANCELLED':
      return 'warning';
    case 'FAILED':
      return 'error';
    default:
      return 'muted';
  }
}

/**
 * @param {object | null | undefined} job
 * @returns {string}
 */
function resultLabel(job) {
  const status = String(job?.status ?? '').toUpperCase();
  if (status === 'COMPLETED') {
    return 'Success';
  }
  if (status === 'FAILED') {
    return job?.lastError?.errorClass ?? 'Failed';
  }
  if (status === 'NEEDS_ATTENTION') {
    return job?.lastError?.errorClass ?? 'Needs attention';
  }
  if (status === 'CANCELLED') {
    return 'Cancelled';
  }
  if (status === 'RUNNING') {
    return 'In progress';
  }
  return '—';
}

/**
 * @param {object} payload
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string, verbose?: boolean, limit?: number }} [options]
 * @returns {string}
 */
export function renderJobsReport(payload, theme, options = {}) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const timezone = options.timezone ?? 'Europe/Berlin';
  const verbose = Boolean(options.verbose);

  /** @type {Record<string, number>} */
  const counts = {
    PENDING: 0,
    RUNNING: 0,
    COMPLETED: 0,
    FAILED: 0,
    NEEDS_ATTENTION: 0,
    CANCELLED: 0,
  };
  for (const job of jobs) {
    const key = String(job?.status ?? 'UNKNOWN');
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const lines = [
    '',
    renderSectionTitle(theme, 'Task Queue'),
    renderHeavyDivider(theme, Math.min(theme.columns, 60)),
    '',
    `  ${theme.paint('Shown:', 'gray')} ${jobs.length}` +
      `     ${theme.paint('Pending:', 'gray')} ${counts.PENDING}` +
      `     ${theme.paint('Running:', 'gray')} ${counts.RUNNING}`,
    `  ${theme.paint('Completed:', 'gray')} ${counts.COMPLETED}` +
      `  ${theme.paint('Failed:', 'gray')} ${counts.FAILED}` +
      `      ${theme.paint('Attention:', 'gray')} ${counts.NEEDS_ATTENTION}`,
    '',
  ];

  if (jobs.length === 0) {
    lines.push(
      renderEmptyState(
        theme,
        'No tasks found.',
        'The queue is empty for this view. New work appears after scheduling or enqueueing tasks.',
      ),
    );
    lines.push(renderHeavyDivider(theme, Math.min(theme.columns, 60)), '');
    return renderBlock(theme, lines);
  }

  lines.push(
    renderTable(theme, {
      columns: [
        { key: 'id', header: 'ID', width: 10 },
        { key: 'type', header: 'TYPE', flex: true },
        { key: 'status', header: 'STATUS', width: 16 },
        { key: 'priority', header: 'PRIORITY', width: 10 },
      ],
      rows: jobs.map((job) => ({
        id: { text: truncateId(job.id), tone: 'muted' },
        type: { text: String(job.type ?? '—'), tone: 'muted' },
        status: {
          text: String(job.status ?? '—'),
          tone: statusTone(job.status),
        },
        priority: {
          text: formatPriority(job.priority),
          tone: 'muted',
        },
      })),
    }),
    '',
    renderTable(theme, {
      columns: [
        { key: 'created', header: 'CREATED', width: 18 },
        { key: 'attempts', header: 'ATTEMPTS', width: 12 },
        { key: 'result', header: 'RESULT', flex: true },
      ],
      rows: jobs.map((job) => ({
        created: {
          text: formatDateTime(job.createdAt, {
            timezone,
            style: 'short',
          }),
          tone: 'muted',
        },
        attempts: {
          text: `${job.attemptCount ?? 0} / ${job.maxAttempts ?? '—'}`,
          tone: 'muted',
        },
        result: {
          text: resultLabel(job),
          tone: statusTone(job.status),
        },
      })),
    }),
  );

  if (verbose) {
    lines.push('', theme.paint('  DETAILS', 'white', { bold: true }), '');
    for (const job of jobs) {
      lines.push(
        `  ${theme.paint(String(job.id), 'cyan')}`,
        `    type=${job.type}  status=${job.status}  priority=${job.priority}`,
        `    scheduledAt=${job.scheduledAt ?? '—'}  completedAt=${job.completedAt ?? '—'}`,
      );
      if (job.lastError) {
        lines.push(
          `    error=${job.lastError.errorClass ?? 'UNKNOWN'}: ${job.lastError.message ?? ''}`,
        );
      }
      if (job.resultMetadata) {
        lines.push(`    result=${JSON.stringify(job.resultMetadata)}`);
      }
      lines.push('');
    }
  }

  lines.push(
    renderHeavyDivider(theme, Math.min(theme.columns, 60)),
    `  Showing ${jobs.length} task${jobs.length === 1 ? '' : 's'}`,
    '',
  );

  return renderBlock(theme, lines);
}
