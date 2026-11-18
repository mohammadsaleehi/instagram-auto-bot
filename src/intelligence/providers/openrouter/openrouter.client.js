import dns from 'node:dns';
import OpenAI from 'openai';
import { resolveOpenRouterConfig } from './openrouter.config.js';
import { OpenRouterError, classifyOpenRouterError } from './openrouter.errors.js';

/**
 * Prefer IPv4 when resolving OpenRouter hosts.
 *
 * On some dual-stack networks, the IPv6 path is answered by a Cloudflare edge
 * that returns HTTP 403 "Access denied by security policy" for the same public
 * endpoints that succeed over IPv4. This does not bypass Cloudflare; it only
 * changes local address-family preference for DNS results.
 *
 * @param {{ forceIpv4?: boolean }} [options]
 */
export function preferOpenRouterIpv4(options = {}) {
  if (options.forceIpv4 === false) {
    return false;
  }
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
    return true;
  }
  return false;
}

/**
 * Create an OpenAI SDK client pointed at OpenRouter.
 *
 * @param {Record<string, unknown>} config
 * @param {{ OpenAIClass?: typeof OpenAI, forceIpv4?: boolean }} [options]
 */
export function createOpenRouterClient(config, options = {}) {
  const resolved = resolveOpenRouterConfig(config);
  // Construction is allowed without credentials so the app can boot.
  // Real operations call assertOpenRouterReady() first.
  preferOpenRouterIpv4({ forceIpv4: options.forceIpv4 });

  const OpenAIClass = options.OpenAIClass ?? OpenAI;
  /** @type {Record<string, string>} */
  const defaultHeaders = {
    'X-Title': resolved.appName,
  };
  if (resolved.appUrl) {
    defaultHeaders['HTTP-Referer'] = resolved.appUrl;
  }

  const client = new OpenAIClass({
    apiKey: resolved.apiKey ?? 'missing-openrouter-api-key',
    baseURL: resolved.baseUrl,
    defaultHeaders,
    timeout: resolved.timeoutMs,
  });

  return { client, resolved };
}

/**
 * @param {import('openai').OpenAI} client
 * @param {Record<string, unknown>} body
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function createChatCompletion(client, body, options = {}) {
  try {
    return await client.chat.completions.create(
      /** @type {any} */ (body),
      options.signal ? { signal: options.signal } : undefined,
    );
  } catch (error) {
    throw classifyOpenRouterError(error);
  }
}

/**
 * @param {import('openai').OpenAI} client
 */
export async function listOpenRouterModels(client) {
  try {
    const result = await client.models.list();
    return result.data ?? [];
  } catch (error) {
    throw classifyOpenRouterError(error);
  }
}

/**
 * Sleep helper for retries.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenRouterError('Request aborted', { code: 'OPENROUTER_TIMEOUT', retryable: false }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new OpenRouterError('Request aborted', { code: 'OPENROUTER_TIMEOUT', retryable: false }));
      },
      { once: true },
    );
  });
}
