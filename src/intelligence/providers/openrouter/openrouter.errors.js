import { IntelligenceError } from '../../constants.js';

export class OpenRouterError extends IntelligenceError {
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   status?: number | null,
   *   retryable?: boolean,
   *   details?: unknown,
   *   cause?: unknown,
   * }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      code: options.code ?? 'OPENROUTER_ERROR',
      details: options.details,
      cause: options.cause,
    });
    this.name = 'OpenRouterError';
    this.status = options.status ?? null;
    this.retryable = Boolean(options.retryable);
  }
}

/**
 * @param {unknown} error
 * @returns {OpenRouterError}
 */
export function classifyOpenRouterError(error) {
  if (error instanceof OpenRouterError) {
    return error;
  }

  const status = Number(
    /** @type {{ status?: number, statusCode?: number }} */ (error)?.status ??
      /** @type {{ status?: number, statusCode?: number }} */ (error)?.statusCode ??
      NaN,
  );
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const bodyText = extractErrorBodyText(error);
  const combined = `${lower}\n${bodyText}`.toLowerCase();

  if (
    status === 403 &&
    (combined.includes('access denied by security policy') ||
      combined.includes('security policy'))
  ) {
    return new OpenRouterError(
      'OpenRouter request blocked by Cloudflare security policy before API authentication. Often caused by IPv6/edge/network path restrictions; try IPv4 preference or another network. This usually does not mean the API key is invalid.',
      {
        code: 'OPENROUTER_SECURITY_POLICY',
        status: 403,
        retryable: false,
        cause: error,
      },
    );
  }
  if (status === 401 || lower.includes('invalid api key') || lower.includes('unauthorized')) {
    return new OpenRouterError('OpenRouter authentication failed. Check OPENROUTER_API_KEY.', {
      code: 'OPENROUTER_AUTH',
      status: 401,
      retryable: false,
      cause: error,
    });
  }
  if (status === 402 || lower.includes('credit') || lower.includes('payment')) {
    return new OpenRouterError('OpenRouter account has insufficient credits or payment required.', {
      code: 'OPENROUTER_CREDITS',
      status: 402,
      retryable: false,
      cause: error,
    });
  }
  if (
    status === 404 ||
    (lower.includes('model') && lower.includes('not found')) ||
    combined.includes('no endpoints found')
  ) {
    return new OpenRouterError('Configured OpenRouter model was not found or is unavailable.', {
      code: 'OPENROUTER_MODEL_NOT_FOUND',
      status: status || 404,
      retryable: false,
      cause: error,
    });
  }
  if (status === 403) {
    return new OpenRouterError('OpenRouter request was forbidden (HTTP 403).', {
      code: 'OPENROUTER_FORBIDDEN',
      status: 403,
      retryable: false,
      cause: error,
    });
  }
  if (status === 429 || lower.includes('rate limit')) {
    return new OpenRouterError('OpenRouter rate limit exceeded.', {
      code: 'OPENROUTER_RATE_LIMIT',
      status: 429,
      retryable: true,
      cause: error,
    });
  }
  if (status >= 500 || lower.includes('unavailable') || lower.includes('overloaded')) {
    return new OpenRouterError('OpenRouter provider is temporarily unavailable.', {
      code: 'OPENROUTER_UNAVAILABLE',
      status: status || 503,
      retryable: true,
      cause: error,
    });
  }
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return new OpenRouterError('OpenRouter request timed out.', {
      code: 'OPENROUTER_TIMEOUT',
      status: status || null,
      retryable: true,
      cause: error,
    });
  }
  if (lower.includes('context length') || lower.includes('maximum context')) {
    return new OpenRouterError('OpenRouter request exceeded model context length.', {
      code: 'OPENROUTER_CONTEXT_LENGTH',
      status: status || 400,
      retryable: false,
      cause: error,
    });
  }
  if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('econn')) {
    return new OpenRouterError('Network failure while contacting OpenRouter.', {
      code: 'OPENROUTER_NETWORK',
      status: null,
      retryable: true,
      cause: error,
    });
  }

  return new OpenRouterError(message || 'OpenRouter request failed', {
    code: 'OPENROUTER_ERROR',
    status: Number.isFinite(status) ? status : null,
    retryable: false,
    cause: error,
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function extractErrorBodyText(error) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const record = /** @type {Record<string, unknown>} */ (error);
  const candidates = [record.error, record.body, record.response, record.message];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = /** @type {Record<string, unknown>} */ (candidate);
      if (typeof nested.message === 'string') return nested.message;
      if (typeof nested.error === 'string') return nested.error;
      try {
        return JSON.stringify(candidate);
      } catch {
        // ignore
      }
    }
  }
  return '';
}
