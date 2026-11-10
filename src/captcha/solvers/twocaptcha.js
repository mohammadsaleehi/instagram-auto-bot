import { CaptchaSolveError } from '../errors.js';

const CREATE_URL = 'https://api.2captcha.com/createTask';
const RESULT_URL = 'https://api.2captcha.com/getTaskResult';

/**
 * @param {string} apiKey
 * @param {object} task
 * @returns {Promise<number>}
 */
async function createTask(apiKey, task) {
  const response = await fetch(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task,
    }),
  });

  const data = await response.json();
  if (data.errorId) {
    throw new CaptchaSolveError(
      `2Captcha createTask failed: ${data.errorCode || data.errorDescription || data.errorId}`,
    );
  }

  if (!data.taskId) {
    throw new CaptchaSolveError('2Captcha createTask returned no taskId');
  }

  return data.taskId;
}

/**
 * @param {string} apiKey
 * @param {number} taskId
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function pollResult(apiKey, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const response = await fetch(RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
    });

    const data = await response.json();
    if (data.errorId) {
      throw new CaptchaSolveError(
        `2Captcha getTaskResult failed: ${data.errorCode || data.errorDescription || data.errorId}`,
      );
    }

    if (data.status === 'ready') {
      const token =
        data.solution?.gRecaptchaResponse ||
        data.solution?.token ||
        data.solution?.text;
      if (!token) {
        throw new CaptchaSolveError('2Captcha returned ready status without a token');
      }
      return token;
    }
  }

  throw new CaptchaSolveError(`2Captcha timed out after ${timeoutMs}ms`);
}

/**
 * Build a 2Captcha task payload for the detected challenge.
 *
 * @param {{
 *   type: string,
 *   websiteURL: string,
 *   websiteKey: string,
 *   invisible?: boolean,
 *   enterprise?: boolean,
 *   action?: string | null,
 *   minScore?: number,
 *   apiDomain?: string | null,
 *   proxy?: string | null,
 * }} input
 */
export function buildTwoCaptchaTask(input) {
  const proxyParts = parseProxy(input.proxy);

  if (input.type === 'recaptcha_v3') {
    /** @type {Record<string, unknown>} */
    const task = {
      type: proxyParts ? 'RecaptchaV3Task' : 'RecaptchaV3TaskProxyless',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      minScore: input.minScore ?? 0.7,
      pageAction: input.action || 'login',
      isEnterprise: Boolean(input.enterprise),
    };
    if (input.apiDomain) {
      task.apiDomain = input.apiDomain;
    }
    return { ...task, ...proxyParts };
  }

  if (input.type === 'hcaptcha') {
    return {
      type: proxyParts ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      ...proxyParts,
    };
  }

  if (input.type === 'turnstile') {
    return {
      type: proxyParts ? 'TurnstileTask' : 'TurnstileTaskProxyless',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      ...proxyParts,
    };
  }

  // Default: reCAPTCHA v2 (checkbox or invisible)
  /** @type {Record<string, unknown>} */
  const task = {
    type: proxyParts ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless',
    websiteURL: input.websiteURL,
    websiteKey: input.websiteKey,
    isInvisible: Boolean(input.invisible),
    isEnterprise: Boolean(input.enterprise),
  };
  if (input.apiDomain) {
    task.apiDomain = input.apiDomain;
  }
  return { ...task, ...proxyParts };
}

/**
 * @param {string | null | undefined} proxy
 * @returns {Record<string, string> | null}
 */
function parseProxy(proxy) {
  if (!proxy) {
    return null;
  }

  try {
    const url = new URL(proxy);
    const protocol = url.protocol.replace(':', '');
    return {
      proxyType: protocol === 'socks5' ? 'SOCKS5' : protocol === 'socks4' ? 'SOCKS4' : 'HTTP',
      proxyAddress: url.hostname,
      proxyPort: url.port || (protocol === 'https' ? '443' : '80'),
      proxyLogin: decodeURIComponent(url.username || ''),
      proxyPassword: decodeURIComponent(url.password || ''),
    };
  } catch {
    throw new CaptchaSolveError('Invalid proxy URL. Expected http://user:pass@host:port');
  }
}

/**
 * Solve a captcha via 2Captcha.
 *
 * @param {{
 *   apiKey: string,
 *   type: string,
 *   websiteURL: string,
 *   websiteKey: string,
 *   invisible?: boolean,
 *   enterprise?: boolean,
 *   action?: string | null,
 *   minScore?: number,
 *   apiDomain?: string | null,
 *   proxy?: string | null,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ token: string, provider: string, taskId: number }>}
 */
export async function solveWithTwoCaptcha(options) {
  if (!options.apiKey) {
    throw new CaptchaSolveError('2Captcha API key is required');
  }

  const task = buildTwoCaptchaTask(options);
  const taskId = await createTask(options.apiKey, task);
  const token = await pollResult(options.apiKey, taskId, options.timeoutMs ?? 120_000);

  return {
    token,
    provider: '2captcha',
    taskId,
  };
}
