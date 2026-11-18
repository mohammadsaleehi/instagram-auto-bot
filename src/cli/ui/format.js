/**
 * Human-readable formatting helpers for CLI presentation.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * @param {string | Date | null | undefined} value
 * @param {{
 *   timezone?: string,
 *   now?: Date,
 *   style?: 'full' | 'short' | 'relative',
 * }} [options]
 * @returns {string}
 */
export function formatDateTime(value, options = {}) {
  if (!value) {
    return '—';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const timezone = options.timezone ?? 'Europe/Berlin';
  const style = options.style ?? 'full';
  const now = options.now ?? new Date();

  if (style === 'relative') {
    const deltaMs = now.getTime() - date.getTime();
    if (deltaMs >= 0 && deltaMs < 45_000) {
      return 'Just now';
    }
    if (deltaMs >= 0 && deltaMs < 3_600_000) {
      const mins = Math.max(1, Math.round(deltaMs / 60_000));
      return `${mins} min ago`;
    }
  }

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: style === 'full' ? '2-digit' : undefined,
      hour12: false,
    }).formatToParts(date);

    const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
    const month = get('month');
    const day = String(Number(get('day')));
    const year = get('year');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');

    if (style === 'short') {
      return `${month} ${day}, ${hour}:${minute}`;
    }

    return second
      ? `${month} ${day}, ${year} · ${hour}:${minute}:${second}`
      : `${month} ${day}, ${year} · ${hour}:${minute}`;
  } catch {
    // Fallback without Intl timezone support.
    const month = MONTHS[date.getUTCMonth()] ?? '???';
    const day = date.getUTCDate();
    const year = date.getUTCFullYear();
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return style === 'short'
      ? `${month} ${day}, ${hh}:${mm}`
      : `${month} ${day}, ${year} · ${hh}:${mm}:${ss}`;
  }
}

/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

/**
 * @param {string | null | undefined} id
 * @param {number} [length=8]
 * @returns {string}
 */
export function truncateId(id, length = 8) {
  if (!id) {
    return '—';
  }
  const value = String(id);
  if (value.length <= length) {
    return value;
  }
  return value.slice(0, length);
}

/**
 * @param {string | null | undefined} text
 * @param {number} width
 * @returns {string}
 */
export function truncateText(text, width) {
  const value = String(text ?? '');
  if (width <= 0) {
    return '';
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return '…';
  }
  return `${value.slice(0, width - 1)}…`;
}

/**
 * @param {string | null | undefined} value
 * @param {number} width
 * @param {'left' | 'right'} [align='left']
 */
export function pad(value, width, align = 'left') {
  const text = String(value ?? '');
  if (text.length >= width) {
    return text.slice(0, width);
  }
  const spaces = ' '.repeat(width - text.length);
  return align === 'right' ? spaces + text : text + spaces;
}

/**
 * @param {number | null | undefined} priority
 * @returns {string}
 */
export function formatPriority(priority) {
  if (priority == null || !Number.isFinite(priority)) {
    return 'Normal';
  }
  if (priority >= 200) {
    return 'High';
  }
  if (priority <= 50) {
    return 'Low';
  }
  return 'Normal';
}

/**
 * Map browser mode to a readable label.
 *
 * @param {string | null | undefined} mode
 * @returns {string}
 */
export function formatBrowserMode(mode) {
  switch (mode) {
    case 'existing':
      return 'Existing Chrome (CDP)';
    case 'launch':
      return 'Isolated launch';
    case 'launch-x11':
      return 'Isolated launch (X11)';
    case 'storage-state':
      return 'Storage-state (server)';
    default:
      return mode ? String(mode) : 'Unknown';
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSensitive(value) {
  const sensitive =
    /^(pass(word)?|secret|token|cookie|authorization|storage.?state|session|username|credentials?|api.?key|openrouter.?api.?key|INSTAGRAM_USERNAME|INSTAGRAM_PASSWORD|OPENROUTER_API_KEY)$/i;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sensitive.test(key) ? '[REDACTED]' : redactSensitive(entry);
    }
    return out;
  }
  return value;
}
