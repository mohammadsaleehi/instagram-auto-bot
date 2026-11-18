/**
 * Terminal theme: colors, symbols, and capability detection.
 */

const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  blue: '\u001b[34m',
  gray: '\u001b[90m',
  white: '\u001b[37m',
});

/**
 * @param {{
 *   stdout?: NodeJS.WriteStream,
 *   stderr?: NodeJS.WriteStream,
 *   env?: NodeJS.ProcessEnv,
 *   columns?: number,
 *   forceColor?: boolean | null,
 *   forceUnicode?: boolean | null,
 * }} [options]
 */
export function createTheme(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  const noColorEnv =
    (env.NO_COLOR !== undefined && env.NO_COLOR !== '') ||
    env.FORCE_COLOR === '0';
  const forceColorEnv =
    env.FORCE_COLOR !== undefined &&
    env.FORCE_COLOR !== '' &&
    env.FORCE_COLOR !== '0';
  const isTty = Boolean(stdout.isTTY);
  // NO_COLOR wins over FORCE_COLOR. Explicit forceColor option wins only when true/false.
  const colorEnabled =
    options.forceColor === false || noColorEnv
      ? false
      : options.forceColor === true
        ? true
        : forceColorEnv || isTty;

  const unicode =
    options.forceUnicode === true
      ? true
      : options.forceUnicode === false
        ? false
        : env.CLI_ASCII === '1'
          ? false
          : Boolean(isTty);

  const columnsRaw =
    options.columns ??
    (typeof stdout.columns === 'number' && stdout.columns > 0
      ? stdout.columns
      : 80);
  const columns = Math.max(40, Math.min(120, columnsRaw));

  /**
   * @param {string} text
   * @param {keyof typeof ANSI | null} [color]
   * @param {{ bold?: boolean, dim?: boolean }} [style]
   */
  const paint = (text, color = null, style = {}) => {
    if (!colorEnabled || !color) {
      return String(text);
    }
    let out = '';
    if (style.bold) {
      out += ANSI.bold;
    }
    if (style.dim) {
      out += ANSI.dim;
    }
    out += ANSI[color] ?? '';
    out += String(text);
    out += ANSI.reset;
    return out;
  };

  const symbols = unicode
    ? {
        bullet: '●',
        idle: '○',
        success: '✓',
        warning: '!',
        error: '✗',
        info: 'ⓘ',
        time: '◷',
        branch: '├─',
        last: '└─',
        line: '─',
        double: '━',
        cornerTL: '╭',
        cornerTR: '╮',
        cornerBL: '╰',
        cornerBR: '╯',
        wall: '│',
      }
    : {
        bullet: '*',
        idle: 'o',
        success: '+',
        warning: '!',
        error: 'x',
        info: 'i',
        time: '~',
        branch: '|-',
        last: '\\-',
        line: '-',
        double: '=',
        cornerTL: '+',
        cornerTR: '+',
        cornerBL: '+',
        cornerBR: '+',
        wall: '|',
      };

  return {
    stdout,
    stderr,
    env,
    colorEnabled,
    unicode,
    columns,
    isTty,
    paint,
    symbols,
    colors: ANSI,
    /**
     * @param {string} tone
     * @returns {keyof typeof ANSI}
     */
    toneColor(tone) {
      switch (tone) {
        case 'success':
        case 'healthy':
        case 'connected':
        case 'completed':
          return 'green';
        case 'warning':
        case 'paused':
        case 'pending':
        case 'attention':
          return 'yellow';
        case 'error':
        case 'failed':
        case 'disconnected':
        case 'critical':
          return 'red';
        case 'info':
        case 'active':
        case 'running':
          return 'cyan';
        case 'muted':
        case 'idle':
        case 'na':
        default:
          return 'gray';
      }
    },
  };
}

/**
 * @typedef {ReturnType<typeof createTheme>} Theme
 */
