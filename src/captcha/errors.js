export class CaptchaError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'CaptchaError';
    this.code = options.code ?? 'CAPTCHA_ERROR';
  }
}

export class CaptchaConfigError extends CaptchaError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message, { code: 'CAPTCHA_CONFIG_ERROR' });
    this.name = 'CaptchaConfigError';
  }
}

export class CaptchaDetectError extends CaptchaError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'CAPTCHA_DETECT_ERROR', cause: options.cause });
    this.name = 'CaptchaDetectError';
  }
}

export class CaptchaSolveError extends CaptchaError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'CAPTCHA_SOLVE_ERROR', cause: options.cause });
    this.name = 'CaptchaSolveError';
  }
}

export class CaptchaInjectError extends CaptchaError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'CAPTCHA_INJECT_ERROR', cause: options.cause });
    this.name = 'CaptchaInjectError';
  }
}
