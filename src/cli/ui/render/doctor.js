import { redactSensitive } from '../format.js';
import {
  renderBlock,
  renderError,
  renderHeavyDivider,
  renderSectionTitle,
  renderSuccess,
  renderWarning,
} from '../layout.js';

/**
 * @param {string} name
 * @returns {string}
 */
function categoryFor(name) {
  if (['config', 'node'].includes(name)) {
    return 'ENVIRONMENT';
  }
  if (['database'].includes(name)) {
    return 'DATABASE';
  }
  if (['browser_availability', 'browser', 'chrome'].includes(name)) {
    return 'BROWSER';
  }
  if (['authentication', 'session_file'].includes(name)) {
    return 'AUTHENTICATION';
  }
  if (['control_socket_permissions', 'runtime', 'handlers', 'storage'].includes(name)) {
    return 'RUNTIME & STORAGE';
  }
  return 'OTHER';
}

/**
 * @param {string} name
 * @returns {string}
 */
function labelFor(name) {
  switch (name) {
    case 'node':
      return 'Node.js version';
    case 'config':
      return 'Configuration valid';
    case 'database':
      return 'SQLite connection & integrity';
    case 'session_file':
      return 'Session file availability';
    case 'browser_availability':
      return 'Browser availability';
    case 'control_socket_permissions':
      return 'Control socket permissions';
    case 'runtime':
      return 'Runtime control channel';
    case 'handlers':
      return 'Task handlers registered';
    case 'authentication':
      return 'Instagram authentication';
    case 'browser':
      return 'Browser connection';
    default:
      return name.replaceAll('_', ' ');
  }
}

/**
 * @param {object} check
 * @returns {'pass' | 'warn' | 'fail'}
 */
export function classifyDoctorCheck(check) {
  if (!check?.ok) {
    return 'fail';
  }

  const detail = check.detail;
  if (check.name === 'control_socket_permissions' && detail?.present && detail?.secure === false) {
    return 'warn';
  }
  if (check.name === 'runtime' && detail?.running === false) {
    return 'warn';
  }
  if (check.name === 'session_file' && detail?.requiredForMode && !detail?.present) {
    return 'fail';
  }
  return 'pass';
}

/**
 * @param {object} check
 * @returns {string}
 */
function detailText(check) {
  const detail = redactSensitive(check.detail);
  if (detail == null) {
    return '';
  }
  if (typeof detail === 'string') {
    return detail;
  }
  if (typeof detail === 'object') {
    if (detail.note) {
      return String(detail.note);
    }
    if (detail.integrity) {
      return `schema v${detail.schemaVersion ?? '?'} · integrity ${detail.integrity}`;
    }
    if (detail.browserMode || detail.timezone) {
      return `mode=${detail.browserMode ?? '?'} · tz=${detail.timezone ?? '?'}`;
    }
    if (detail.mode || detail.channel) {
      return String(detail.note ?? `mode=${detail.mode}`);
    }
    if (detail.running === false) {
      return String(detail.note ?? 'Bot is not running (offline diagnostics only)');
    }
    if (detail.running === true) {
      return 'Bot runtime is reachable';
    }
    if (detail.present === false) {
      return String(detail.note ?? 'Not present');
    }
    if (detail.present === true) {
      return String(detail.note ?? `mode ${detail.mode ?? ''}`.trim());
    }
  }
  return '';
}

/**
 * @param {object} check
 * @returns {string | null}
 */
function recoveryHint(check) {
  if (classifyDoctorCheck(check) === 'pass') {
    return null;
  }
  switch (check.name) {
    case 'config':
      return 'Fix invalid environment values in .env and re-run doctor.';
    case 'database':
      return 'Stop the bot, restore a SQLite backup into data/bot.sqlite, then restart.';
    case 'session_file':
      return 'Run npm run login and securely copy data/instagram-auth.json for storage-state mode.';
    case 'browser_availability':
      return 'Install Google Chrome/Chromium or set BROWSER_EXECUTABLE_PATH.';
    case 'control_socket_permissions':
      return 'Remove the insecure socket and restart the bot so it recreates a user-only socket.';
    case 'runtime':
      return 'Start the bot with npm start to enable live diagnostics.';
    case 'authentication':
      return check.detail?.recovery ?? 'Complete login in Chrome or run npm run login.';
    case 'browser':
      return 'Enable chrome://inspect/#remote-debugging and ensure Chrome is open.';
    default:
      return 'Review the failing check detail and retry.';
  }
}

/**
 * @param {{ ok?: boolean, checks?: object[] }} report
 * @param {import('../theme.js').Theme} theme
 * @returns {string}
 */
export function renderDoctorReport(report, theme) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  /** @type {Map<string, object[]>} */
  const grouped = new Map();

  for (const check of checks) {
    const category = categoryFor(String(check.name ?? 'other'));
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)?.push(check);
  }

  let passed = 0;
  let warnings = 0;
  let failures = 0;
  for (const check of checks) {
    const level = classifyDoctorCheck(check);
    if (level === 'pass') {
      passed += 1;
    } else if (level === 'warn') {
      warnings += 1;
    } else {
      failures += 1;
    }
  }

  const lines = [
    '',
    renderSectionTitle(theme, 'System Diagnostics'),
    renderHeavyDivider(theme, Math.min(theme.columns, 60)),
    '',
  ];

  for (const [category, items] of grouped) {
    lines.push(renderSectionTitle(theme, category));
    for (const check of items) {
      const level = classifyDoctorCheck(check);
      const label = labelFor(String(check.name));
      const detail = detailText(check);
      if (level === 'pass') {
        lines.push(renderSuccess(theme, label));
      } else if (level === 'warn') {
        lines.push(renderWarning(theme, label));
      } else {
        lines.push(renderError(theme, label));
      }
      if (detail) {
        lines.push(`    ${theme.paint(detail, 'gray')}`);
      }
      const hint = recoveryHint(check);
      if (hint && level !== 'pass') {
        lines.push(`    ${theme.paint(`Hint: ${hint}`, 'yellow')}`);
      }
    }
    lines.push('');
  }

  lines.push(renderHeavyDivider(theme, Math.min(theme.columns, 60)), '');

  if (failures > 0) {
    lines.push(
      `  ${theme.paint('RESULT: CHECKS FAILED', 'red', { bold: true })}`,
    );
  } else if (warnings > 0) {
    lines.push(
      `  ${theme.paint('RESULT: PASSED WITH WARNINGS', 'yellow', { bold: true })}`,
    );
  } else {
    lines.push(
      `  ${theme.paint('RESULT: ALL CHECKS PASSED', 'green', { bold: true })}`,
    );
  }

  lines.push(
    `  ${passed} checks passed · ${warnings} warnings · ${failures} failures`,
    '',
  );

  return renderBlock(theme, lines);
}

/**
 * Exit code: 0 pass/warn, 1 on failures.
 *
 * @param {{ ok?: boolean, checks?: object[] }} report
 * @returns {number}
 */
export function doctorExitCode(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const hasFailure = checks.some((check) => classifyDoctorCheck(check) === 'fail');
  return hasFailure ? 1 : 0;
}
