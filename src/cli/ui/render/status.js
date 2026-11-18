import {
  formatBrowserMode,
  formatDateTime,
  formatDuration,
} from '../format.js';
import {
  renderBlock,
  renderDivider,
  renderHeader,
  renderKeyValue,
  renderSectionTitle,
  renderWarning,
} from '../layout.js';

/**
 * Compute overall health from a status payload without inventing data.
 *
 * @param {object} status
 * @returns {{ label: string, tone: string, warnings: string[] }}
 */
export function assessOverallHealth(status) {
  /** @type {string[]} */
  const warnings = [];
  const browserConnected = Boolean(status?.browser?.connected);
  const authInvalid = Boolean(status?.authentication?.invalid);
  const authState = status?.authentication?.state;
  const dbOk = Boolean(status?.database?.open && status?.database?.integrityOk);
  const needsAttention = Number(status?.needsAttentionCount ?? 0);
  const failed = Number(status?.failedTaskCount ?? 0);
  const appState = String(status?.applicationState ?? 'UNKNOWN');
  const workerPaused = Boolean(status?.worker?.paused);

  if (!browserConnected) {
    warnings.push('Browser is disconnected.');
  }
  if (authInvalid || (authState && authState !== 'AUTHENTICATED')) {
    warnings.push(
      status?.authentication?.recovery ??
        'Instagram authentication requires attention.',
    );
  }
  if (!dbOk) {
    warnings.push('Database is unavailable or failed integrity checks.');
  }
  if (needsAttention > 0) {
    warnings.push(`${needsAttention} task(s) need attention.`);
  }
  if (failed > 0) {
    warnings.push(`${failed} failed task(s) recorded.`);
  }
  if (status?.lastError) {
    warnings.push(String(status.lastError));
  }

  const critical =
    !browserConnected ||
    authInvalid ||
    (authState && authState !== 'AUTHENTICATED') ||
    !dbOk;

  if (critical) {
    return { label: 'UNHEALTHY', tone: 'error', warnings };
  }
  if (workerPaused || appState === 'PAUSED' || needsAttention > 0 || failed > 0) {
    return {
      label: workerPaused || appState === 'PAUSED' ? 'PAUSED' : 'DEGRADED',
      tone: 'warning',
      warnings,
    };
  }
  return { label: 'HEALTHY', tone: 'success', warnings };
}

/**
 * @param {string | null | undefined} state
 */
function appTone(state) {
  switch (state) {
    case 'RUNNING':
      return 'running';
    case 'PAUSED':
      return 'paused';
    case 'FAILED':
    case 'STOPPED':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * @param {object} status
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string }} [options]
 * @returns {string}
 */
export function renderStatusDashboard(status, theme, options = {}) {
  const timezone = options.timezone ?? 'Europe/Berlin';
  const overall = assessOverallHealth(status);
  const counts = status?.worker?.counts ?? {};
  const workerRunning = Boolean(status?.worker?.running);
  const workerPaused = Boolean(status?.worker?.paused);
  const current = status?.runningTask ?? status?.worker?.currentTask ?? null;
  const last = status?.lastSuccessfulTask ?? null;
  const authState = status?.authentication?.state ?? 'UNKNOWN';
  const authTone =
    authState === 'AUTHENTICATED' && !status?.authentication?.invalid
      ? 'success'
      : 'error';

  /** @type {string[]} */
  const lines = [
    '',
    renderHeader(theme, 'INSTAGRAM AUTOMATION BOT', 'System Overview'),
    '',
    renderSectionTitle(theme, 'Application'),
    renderKeyValue(theme, {
      label: 'Status',
      value: String(status?.applicationState ?? 'UNKNOWN'),
      tone: appTone(status?.applicationState),
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Started',
      value: formatDateTime(status?.startedAt, { timezone }),
      tone: 'muted',
      marker: 'time',
    }),
    '',
    renderSectionTitle(theme, 'Browser & Account'),
    renderKeyValue(theme, {
      label: 'Browser',
      value: status?.browser?.connected ? 'Connected' : 'Disconnected',
      tone: status?.browser?.connected ? 'success' : 'error',
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Mode',
      value: formatBrowserMode(status?.browser?.mode),
      tone: 'muted',
      marker: 'branch',
    }),
    renderKeyValue(theme, {
      label: 'Instagram',
      value: String(authState),
      tone: authTone,
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Last checked',
      value: formatDateTime(status?.authentication?.lastCheckedAt, {
        timezone,
        style: 'relative',
      }),
      tone: 'muted',
      marker: 'last',
    }),
    '',
    renderSectionTitle(theme, 'Task Engine'),
    renderKeyValue(theme, {
      label: 'Worker',
      value: workerPaused
        ? 'PAUSED'
        : workerRunning
          ? 'RUNNING'
          : 'STOPPED',
      tone: workerPaused ? 'paused' : workerRunning ? 'running' : 'error',
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Processing',
      value: current
        ? `${current.type ?? 'task'} (${String(current.id ?? '').slice(0, 8)})`
        : 'Idle',
      tone: current ? 'active' : 'idle',
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Pending',
      value: String(counts.PENDING ?? status?.queueSize ?? 0),
      tone: 'muted',
      marker: 'branch',
    }),
    renderKeyValue(theme, {
      label: 'Completed',
      value: String(counts.COMPLETED ?? 0),
      tone: 'muted',
      marker: 'branch',
    }),
    renderKeyValue(theme, {
      label: 'Failed',
      value: String(counts.FAILED ?? status?.failedTaskCount ?? 0),
      tone: Number(counts.FAILED ?? status?.failedTaskCount ?? 0) > 0 ? 'warning' : 'muted',
      marker: 'branch',
    }),
    renderKeyValue(theme, {
      label: 'Needs attention',
      value: String(counts.NEEDS_ATTENTION ?? status?.needsAttentionCount ?? 0),
      tone:
        Number(counts.NEEDS_ATTENTION ?? status?.needsAttentionCount ?? 0) > 0
          ? 'attention'
          : 'muted',
      marker: 'last',
    }),
  ];

  if (last) {
    lines.push(
      '',
      renderSectionTitle(theme, 'Last Successful Task'),
      renderKeyValue(theme, {
        label: 'Type',
        value: String(last.type ?? '—'),
        tone: 'muted',
        marker: 'branch',
      }),
      renderKeyValue(theme, {
        label: 'Completed',
        value: formatDateTime(last.completedAt, { timezone }),
        tone: 'muted',
        marker: 'branch',
      }),
      renderKeyValue(theme, {
        label: 'ID',
        value: String(last.id ?? '—'),
        tone: 'muted',
        marker: 'last',
      }),
    );
  }

  lines.push(
    '',
    renderSectionTitle(theme, 'Database'),
    renderKeyValue(theme, {
      label: 'Connection',
      value: status?.database?.open ? 'Healthy' : 'Unavailable',
      tone: status?.database?.open ? 'success' : 'error',
      marker: 'bullet',
    }),
    renderKeyValue(theme, {
      label: 'Integrity',
      value: status?.database?.integrityOk ? 'Passed' : 'Failed',
      tone: status?.database?.integrityOk ? 'success' : 'error',
      marker: 'bullet',
    }),
    '',
    renderSectionTitle(theme, 'Session'),
    renderKeyValue(theme, {
      label: 'Last persistence',
      value:
        status?.lastSessionPersistence
          ? formatDateTime(status.lastSessionPersistence, { timezone })
          : status?.browser?.mode === 'storage-state'
            ? 'Never'
            : 'Not applicable (CDP mode)',
      tone: 'muted',
      marker: 'time',
    }),
    '',
    renderDivider(theme, Math.min(theme.columns, 58)),
    `  Overall health: ${theme.paint(overall.label, theme.toneColor(overall.tone), { bold: true })}`,
  );

  if (overall.warnings.length > 0) {
    lines.push('');
    for (const warning of overall.warnings.slice(0, 5)) {
      lines.push(renderWarning(theme, warning));
    }
  }

  lines.push('');
  return renderBlock(theme, lines);
}
