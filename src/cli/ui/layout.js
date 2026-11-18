import { pad, truncateText } from './format.js';

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} title
 * @param {string} [subtitle]
 * @returns {string}
 */
export function renderHeader(theme, title, subtitle) {
  const width = Math.min(theme.columns, 60);
  const inner = width - 2;
  const { symbols, paint } = theme;
  const lines = [];

  const center = (text) => {
    const clipped = truncateText(text, inner);
    const left = Math.floor((inner - clipped.length) / 2);
    const right = inner - clipped.length - left;
    return `${' '.repeat(left)}${clipped}${' '.repeat(right)}`;
  };

  lines.push(
    paint(
      `${symbols.cornerTL}${symbols.line.repeat(inner)}${symbols.cornerTR}`,
      'cyan',
    ),
  );
  lines.push(
    `${paint(symbols.wall, 'cyan')}${paint(center(title), 'cyan', { bold: true })}${paint(symbols.wall, 'cyan')}`,
  );
  if (subtitle) {
    lines.push(
      `${paint(symbols.wall, 'cyan')}${paint(center(subtitle), 'gray')}${paint(symbols.wall, 'cyan')}`,
    );
  }
  lines.push(
    paint(
      `${symbols.cornerBL}${symbols.line.repeat(inner)}${symbols.cornerBR}`,
      'cyan',
    ),
  );

  return lines.join('\n');
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} title
 * @returns {string}
 */
export function renderSectionTitle(theme, title) {
  return theme.paint(title.toUpperCase(), 'white', { bold: true });
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {number} [width]
 * @returns {string}
 */
export function renderDivider(theme, width = theme.columns) {
  const w = Math.min(Math.max(width, 20), theme.columns);
  return theme.paint(theme.symbols.line.repeat(w), 'gray');
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {number} [width]
 * @returns {string}
 */
export function renderHeavyDivider(theme, width = theme.columns) {
  const w = Math.min(Math.max(width, 20), theme.columns);
  return theme.paint(theme.symbols.double.repeat(w), 'gray');
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {{
 *   label: string,
 *   value: string,
 *   tone?: string,
 *   marker?: 'bullet' | 'branch' | 'last' | 'time' | 'none',
 *   labelWidth?: number,
 * }} row
 * @returns {string}
 */
export function renderKeyValue(theme, row) {
  const labelWidth = row.labelWidth ?? 22;
  const markerKey = row.marker ?? 'none';
  const markerRaw =
    markerKey === 'none'
      ? ' '
      : markerKey === 'bullet'
        ? theme.symbols.bullet
        : markerKey === 'time'
          ? theme.symbols.time
          : markerKey === 'branch'
            ? theme.symbols.branch
            : theme.symbols.last;
  // Keep markers in a fixed 2-column gutter for alignment across ● / ├─ / └─.
  const marker = pad(markerRaw, 2);

  const tone = row.tone ?? 'muted';
  const color = theme.toneColor(tone);
  const markerColor =
    markerKey === 'bullet' || markerKey === 'time' ? color : 'gray';

  const label = pad(row.label, labelWidth);
  const value = truncateText(row.value, Math.max(8, theme.columns - labelWidth - 8));

  return `  ${theme.paint(marker, markerColor)} ${theme.paint(label, 'gray')} ${theme.paint(value, color, {
    bold: markerKey === 'bullet',
  })}`;
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string[]} lines
 * @returns {string}
 */
export function renderBlock(theme, lines) {
  void theme;
  return lines.filter((line) => line !== null && line !== undefined).join('\n');
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} message
 * @returns {string}
 */
export function renderSuccess(theme, message) {
  return `  ${theme.paint(theme.symbols.success, 'green')} ${theme.paint(message, 'green', { bold: true })}`;
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} message
 * @returns {string}
 */
export function renderWarning(theme, message) {
  return `  ${theme.paint(theme.symbols.warning, 'yellow')} ${theme.paint(message, 'yellow', { bold: true })}`;
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} message
 * @returns {string}
 */
export function renderError(theme, message) {
  return `  ${theme.paint(theme.symbols.error, 'red')} ${theme.paint(message, 'red', { bold: true })}`;
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} message
 * @returns {string}
 */
export function renderInfo(theme, message) {
  return `  ${theme.paint(theme.symbols.info, 'cyan')} ${theme.paint(message, 'cyan')}`;
}

/**
 * @param {import('./theme.js').Theme} theme
 * @param {string} title
 * @param {string} [hint]
 * @returns {string}
 */
export function renderEmptyState(theme, title, hint) {
  const lines = [
    '',
    `  ${theme.paint(title, 'gray')}`,
  ];
  if (hint) {
    lines.push(`  ${theme.paint(hint, 'gray')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Simple aligned table renderer.
 *
 * @param {import('./theme.js').Theme} theme
 * @param {{
 *   columns: Array<{ key: string, header: string, width?: number, flex?: boolean }>,
 *   rows: Array<Record<string, { text: string, tone?: string } | string>>,
 * }} input
 * @returns {string}
 */
export function renderTable(theme, input) {
  const available = Math.max(40, theme.columns - 2);
  const fixed = input.columns.reduce(
    (sum, col) => sum + (col.flex ? 0 : col.width ?? 12),
    0,
  );
  const flexCount = input.columns.filter((col) => col.flex).length || 1;
  const flexWidth = Math.max(
    8,
    Math.floor((available - fixed - (input.columns.length - 1)) / flexCount),
  );

  const widths = input.columns.map((col) =>
    col.flex ? flexWidth : col.width ?? 12,
  );

  const header = input.columns
    .map((col, index) =>
      theme.paint(pad(col.header, widths[index]), 'gray', { bold: true }),
    )
    .join(' ');

  const divider = theme.paint(
    theme.symbols.line.repeat(Math.min(available, widths.reduce((a, b) => a + b + 1, -1))),
    'gray',
  );

  const body = input.rows.map((row) =>
    input.columns
      .map((col, index) => {
        const cell = row[col.key];
        const text =
          typeof cell === 'string' ? cell : String(cell?.text ?? '');
        const tone = typeof cell === 'object' && cell ? cell.tone : 'muted';
        return theme.paint(
          pad(truncateText(text, widths[index]), widths[index]),
          theme.toneColor(tone ?? 'muted'),
        );
      })
      .join(' '),
  );

  return ['  ' + header, '  ' + divider, ...body.map((line) => '  ' + line)].join(
    '\n',
  );
}

/**
 * Write human text to stdout; errors to stderr.
 *
 * @param {import('./theme.js').Theme} theme
 * @param {string} text
 * @param {'stdout' | 'stderr'} [stream='stdout']
 */
export function writeOutput(theme, text, stream = 'stdout') {
  const target = stream === 'stderr' ? theme.stderr : theme.stdout;
  target.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Emit compact JSON with no ANSI.
 *
 * @param {import('./theme.js').Theme} theme
 * @param {unknown} payload
 */
export function writeJson(theme, payload) {
  theme.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
