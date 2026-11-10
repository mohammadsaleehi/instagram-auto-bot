const LEVEL_PRIORITY = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Redact values that look sensitive before logging.
 *
 * @param {unknown} value
 * @param {string} [key='']
 * @returns {unknown}
 */
function sanitize(value, key = '') {
  const sensitiveKey =
    /^(pass(word)?|secret|token|cookie|authorization|storage.?state|session|username|credentials?|INSTAGRAM_USERNAME|INSTAGRAM_PASSWORD)$/i;

  if (sensitiveKey.test(key)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = sanitize(entryValue, entryKey);
    }
    return result;
  }

  return value;
}

/**
 * Create a simple structured logger.
 *
 * @param {{ level?: string }} [options]
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const threshold = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;

  /**
   * @param {'error' | 'warn' | 'info' | 'debug'} severity
   * @param {string} message
   * @param {Record<string, unknown>} [meta]
   */
  function write(severity, message, meta) {
    if ((LEVEL_PRIORITY[severity] ?? 0) > threshold) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level: severity,
      message,
      ...(meta ? { meta: sanitize(meta) } : {}),
    };

    const line = JSON.stringify(entry);
    if (severity === 'error') {
      console.error(line);
      return;
    }

    if (severity === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [meta]
     */
    error(message, meta) {
      write('error', message, meta);
    },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [meta]
     */
    warn(message, meta) {
      write('warn', message, meta);
    },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [meta]
     */
    info(message, meta) {
      write('info', message, meta);
    },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [meta]
     */
    debug(message, meta) {
      write('debug', message, meta);
    },
  };
}
