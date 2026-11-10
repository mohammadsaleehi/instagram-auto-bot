import { CaptchaConfigError } from '../errors.js';
import { solveWithTwoCaptcha } from './twocaptcha.js';
import { solveWithCapSolver } from './capsolver.js';

/**
 * @param {'2captcha' | 'capsolver'} provider
 * @param {Parameters<typeof solveWithTwoCaptcha>[0]} options
 */
export async function solveCaptcha(provider, options) {
  if (provider === '2captcha') {
    return solveWithTwoCaptcha(options);
  }

  if (provider === 'capsolver') {
    return solveWithCapSolver(options);
  }

  throw new CaptchaConfigError(`Unsupported captcha solver: ${provider}`);
}

export { buildTwoCaptchaTask } from './twocaptcha.js';
export { buildCapSolverTask } from './capsolver.js';
