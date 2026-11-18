import {
  renderBlock,
  renderError,
  renderInfo,
  renderSuccess,
  renderWarning,
} from '../layout.js';

/**
 * @param {object} result
 * @param {import('../theme.js').Theme} theme
 * @returns {string}
 */
export function renderPauseResult(result, theme) {
  const lines = [
    '',
    `  ${theme.paint('Instagram Automation Bot', 'cyan', { bold: true })}`,
    '',
  ];

  if (result?.paused) {
    if (result?.changed === false || result?.alreadyPaused) {
      lines.push(renderWarning(theme, 'Worker was already paused.'));
      lines.push('');
      lines.push(theme.paint('  No state change was required.', 'gray'));
    } else {
      lines.push(renderSuccess(theme, 'Worker paused successfully.'));
      lines.push('');
      lines.push(theme.paint('  New tasks will not be claimed.', 'gray'));
      lines.push(
        theme.paint(
          '  The current task is handled according to its cancellation and safety policy.',
          'gray',
        ),
      );
    }
  } else {
    lines.push(renderError(theme, 'Pause request failed.'));
    if (result?.reason) {
      lines.push(`  ${theme.paint(String(result.reason), 'gray')}`);
    }
  }

  lines.push('');
  return renderBlock(theme, lines);
}

/**
 * @param {object} result
 * @param {import('../theme.js').Theme} theme
 * @returns {string}
 */
export function renderResumeResult(result, theme) {
  const lines = [
    '',
    `  ${theme.paint('Instagram Automation Bot', 'cyan', { bold: true })}`,
    '',
  ];

  if (result?.resumed) {
    if (result?.changed === false || result?.alreadyRunning) {
      lines.push(renderInfo(theme, 'Worker was already running.'));
      lines.push('');
      lines.push(theme.paint('  Task processing remains active.', 'gray'));
    } else {
      lines.push(renderSuccess(theme, 'Worker resumed successfully.'));
      lines.push('');
      lines.push(theme.paint('  Task processing is active.', 'gray'));
    }
  } else {
    lines.push(renderError(theme, 'Resume request was rejected.'));
    if (result?.reason) {
      lines.push(`  ${theme.paint(String(result.reason), 'yellow')}`);
    }
    if (result?.recovery) {
      lines.push(`  ${theme.paint(`Recovery: ${result.recovery}`, 'gray')}`);
    }
  }

  lines.push('');
  return renderBlock(theme, lines);
}

/**
 * @param {Error | { message?: string, code?: string }} error
 * @param {import('../theme.js').Theme} theme
 * @returns {string}
 */
export function renderControlError(error, theme) {
  const message = error?.message ?? String(error);
  const lines = [
    '',
    `  ${theme.paint('Instagram Automation Bot', 'cyan', { bold: true })}`,
    '',
    renderError(theme, 'Unable to reach the running bot.'),
    `  ${theme.paint(message, 'gray')}`,
    '',
    theme.paint('  Start the application with: npm start', 'cyan'),
    '',
  ];
  return renderBlock(theme, lines);
}
