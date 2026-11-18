import { formatDateTime, formatDuration } from '../format.js';
import { renderSectionTitle } from '../layout.js';

/**
 * @param {ReadonlyArray<object>} items
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string, title?: string }} [options]
 */
export function renderContentList(items, theme, options = {}) {
  const lines = [
    renderSectionTitle(theme, options.title ?? 'Content'),
    theme.paint(`${items.length} item(s)`, 'gray'),
    '',
  ];

  if (items.length === 0) {
    lines.push(theme.paint('No content items found.', 'gray'));
    return lines.join('\n');
  }

  for (const item of items) {
    const storyMeta = item.story
      ? `  ${item.story.storyMediaType}${item.story.storyGroupId ? ` group=${item.story.storyGroupId}#${item.story.sequenceOrder}` : ''}`
      : '';
    lines.push(
      `${theme.paint(item.id.slice(0, 8), 'cyan')}  ${theme.paint(String(item.status).padEnd(16), 'white', { bold: true })}  ${String(item.contentType).padEnd(9)}  ${item.title || theme.paint('(untitled)', 'gray')}`,
    );
    lines.push(
      theme.paint(
        `  updated ${formatDateTime(item.updatedAt, { timezone: options.timezone, style: 'short' })}  approval=${item.approvalStatus}${storyMeta}`,
        'gray',
      ),
    );
  }

  return lines.join('\n');
}

/**
 * @param {ReadonlyArray<object>} items
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderStoryList(items, theme, options = {}) {
  return renderContentList(items, theme, { ...options, title: 'Stories' });
}

/**
 * @param {object} item
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string, captionPreview?: string }} [options]
 */
export function renderContentDetail(item, theme, options = {}) {
  const lines = [
    theme.paint(item.title || 'Untitled content', 'white', { bold: true }),
    `${theme.paint('id', 'gray')}          ${item.id}`,
    `${theme.paint('type', 'gray')}        ${item.contentType}`,
    `${theme.paint('status', 'gray')}      ${item.status}`,
    `${theme.paint('approval', 'gray')}    ${item.approvalStatus}`,
    `${theme.paint('scheduled', 'gray')}   ${formatDateTime(item.scheduledAt, { timezone: options.timezone })}`,
    `${theme.paint('published', 'gray')}   ${formatDateTime(item.publishedAt, { timezone: options.timezone })}`,
    `${theme.paint('external id', 'gray')} ${item.externalPublishId ?? '—'}`,
    `${theme.paint('created', 'gray')}     ${formatDateTime(item.createdAt, { timezone: options.timezone })}`,
    `${theme.paint('updated', 'gray')}     ${formatDateTime(item.updatedAt, { timezone: options.timezone })}`,
    '',
    theme.paint('Caption', 'white', { bold: true }),
    item.caption || theme.paint('(empty)', 'gray'),
  ];

  if (options.captionPreview && options.captionPreview !== item.caption) {
    lines.push('', theme.paint('Publish preview', 'white', { bold: true }), options.captionPreview);
  }

  if (item.hashtags?.length) {
    lines.push('', theme.paint('Hashtags', 'white', { bold: true }), item.hashtags.join(' '));
  }

  lines.push('', theme.paint(`Media (${item.media?.length ?? 0})`, 'white', { bold: true }));
  if (!item.media?.length) {
    lines.push(theme.paint('  (none)', 'gray'));
  } else {
    for (const media of item.media) {
      const dims =
        media.width && media.height ? `  ${media.width}x${media.height}` : '';
      const duration =
        media.durationMs != null ? `  ${Math.round(media.durationMs / 1000)}s` : '';
      lines.push(
        `  - ${media.mediaKind}/${media.mimeType}  ${media.byteSize} bytes${dims}${duration}  ${media.originalName}`,
      );
    }
  }

  if (item.story) {
    lines.push('', theme.paint('Story', 'white', { bold: true }));
    lines.push(`${theme.paint('media type', 'gray')}  ${item.story.storyMediaType}`);
    lines.push(
      `${theme.paint('group', 'gray')}       ${item.story.storyGroupId ?? '—'}  order=${item.story.sequenceOrder}`,
    );
    lines.push(
      `${theme.paint('container', 'gray')}   ${item.story.storyContainerId ?? '—'}`,
    );
    lines.push(
      `${theme.paint('published', 'gray')}   ${formatDateTime(item.story.storyPublishedAt, { timezone: options.timezone })}`,
    );
    lines.push(
      `${theme.paint('expires', 'gray')}     ${formatDateTime(item.story.storyExpiresAt, { timezone: options.timezone })}`,
    );
    if (options.storyRemainingMs != null) {
      lines.push(
        `${theme.paint('remaining', 'gray')}   ${formatDuration(options.storyRemainingMs)}`,
      );
    }
    if (item.storyValidation?.warnings?.length) {
      lines.push('', theme.paint('Validation warnings', 'yellow', { bold: true }));
      for (const warning of item.storyValidation.warnings) {
        lines.push(theme.paint(`  - ${warning}`, 'yellow'));
      }
    }
  }

  if (item.lastError) {
    lines.push('', theme.paint(`Last error: ${item.lastError}`, 'red'));
  }

  return lines.join('\n');
}

/**
 * @param {{ upcoming: object[], missed: object[] }} calendar
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderContentCalendar(calendar, theme, options = {}) {
  const lines = [renderSectionTitle(theme, 'Content calendar'), ''];
  lines.push(theme.paint('Upcoming', 'white', { bold: true }));
  if (!calendar.upcoming.length) {
    lines.push(theme.paint('  (none)', 'gray'));
  } else {
    for (const item of calendar.upcoming) {
      lines.push(
        `  ${formatDateTime(item.scheduledAt, { timezone: options.timezone })}  ${item.title || item.id}`,
      );
    }
  }
  lines.push('', theme.paint('Missed', 'white', { bold: true }));
  if (!calendar.missed.length) {
    lines.push(theme.paint('  (none)', 'gray'));
  } else {
    for (const item of calendar.missed) {
      lines.push(
        `  ${formatDateTime(item.scheduledAt, { timezone: options.timezone })}  ${item.title || item.id}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * @param {{ content: object, approvals: object[], publishing: object[] }} history
 * @param {import('../theme.js').Theme} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderContentHistory(history, theme, options = {}) {
  const lines = [
    renderSectionTitle(theme, `History · ${history.content.title || history.content.id}`),
    '',
    theme.paint('Approvals', 'white', { bold: true }),
  ];
  if (!history.approvals.length) {
    lines.push(theme.paint('  (none)', 'gray'));
  } else {
    for (const row of history.approvals) {
      lines.push(
        `  ${formatDateTime(row.createdAt, { timezone: options.timezone, style: 'short' })}  ${row.action} by ${row.actor}${row.note ? ` — ${row.note}` : ''}`,
      );
    }
  }

  lines.push('', theme.paint('Publishing attempts', 'white', { bold: true }));
  if (!history.publishing.length) {
    lines.push(theme.paint('  (none)', 'gray'));
  } else {
    for (const row of history.publishing) {
      const sim = row.dryRun || row.result?.simulated ? ' [simulated/dry-run]' : '';
      lines.push(`  #${row.attemptNumber} ${row.status} via ${row.adapter}${sim}`);
      lines.push(
        `    ${formatDateTime(row.createdAt, { timezone: options.timezone, style: 'short' })}  external=${row.externalPublishId ?? '—'}`,
      );
    }
  }

  return lines.join('\n');
}
