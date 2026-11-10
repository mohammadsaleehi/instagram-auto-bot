import { CaptchaSolveError } from '../errors.js';

const CREATE_URL = 'https://api.capsolver.com/createTask';
const RESULT_URL = 'https://api.capsolver.com/getTaskResult';

/**
 * @param {string} apiKey
 * @param {object} task
 * @returns {Promise<string>}
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
      `CapSolver createTask failed: ${data.errorCode || data.errorDescription || data.errorId}`,
    );
  }

  if (!data.taskId) {
    throw new CaptchaSolveError('CapSolver createTask returned no taskId');
  }

  return data.taskId;
}

/**
 * @param {string} apiKey
 * @param {string} taskId
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function pollResult(apiKey, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));

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
        `CapSolver getTaskResult failed: ${data.errorCode || data.errorDescription || data.errorId}`,
      );
    }

    if (data.status === 'ready') {
      const token =
        data.solution?.gRecaptchaResponse ||
        data.solution?.token ||
        data.solution?.text;
      if (!token) {
        throw new CaptchaSolveError('CapSolver returned ready status without a token');
      }
      return token;
    }
  }

  throw new CaptchaSolveError(`CapSolver timed out after ${timeoutMs}ms`);
}

/**
 * @param {{
 *   type: string,
 *   websiteURL: string,
 *   websiteKey: string,
 *   invisible?: boolean,
 *   enterprise?: boolean,
 *   action?: string | null,
 *   minScore?: number,
 *   proxy?: string | null,
 * }} input
 */
export function buildCapSolverTask(input) {
  const proxy = input.proxy || undefined;

  if (input.type === 'recaptcha_v3') {
    return {
      type: proxy ? 'ReCaptchaV3Task' : 'ReCaptchaV3TaskProxyLess',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      pageAction: input.action || 'login',
      minScore: input.minScore ?? 0.7,
      isEnterprise: Boolean(input.enterprise),
      proxy,
    };
  }

  if (input.type === 'hcaptcha') {
    return {
      type: proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      proxy,
    };
  }

  if (input.type === 'turnstile') {
    return {
      type: proxy ? 'AntiTurnstileTask' : 'AntiTurnstileTaskProxyLess',
      websiteURL: input.websiteURL,
      websiteKey: input.websiteKey,
      proxy,
    };
  }

  return {
    type: proxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess',
    websiteURL: input.websiteURL,
    websiteKey: input.websiteKey,
    isInvisible: Boolean(input.invisible),
    isEnterprise: Boolean(input.enterprise),
    proxy,
  };
}

/**
 * @param {{
 *   apiKey: string,
 *   type: string,
 *   websiteURL: string,
 *   websiteKey: string,
 *   invisible?: boolean,
 *   enterprise?: boolean,
 *   action?: string | null,
 *   minScore?: number,
 *   proxy?: string | null,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ token: string, provider: string, taskId: string }>}
 */
export async function solveWithCapSolver(options) {
  if (!options.apiKey) {
    throw new CaptchaSolveError('CapSolver API key is required');
  }

  const task = buildCapSolverTask(options);
  const taskId = await createTask(options.apiKey, task);
  const token = await pollResult(options.apiKey, taskId, options.timeoutMs ?? 120_000);

  return {
    token,
    provider: 'capsolver',
    taskId,
  };
}
