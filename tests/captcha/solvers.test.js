import { describe, expect, it } from 'vitest';
import { buildTwoCaptchaTask } from '../../src/captcha/solvers/twocaptcha.js';
import { buildCapSolverTask } from '../../src/captcha/solvers/capsolver.js';

describe('buildTwoCaptchaTask', () => {
  it('builds proxyless reCAPTCHA v2 tasks', () => {
    const task = buildTwoCaptchaTask({
      type: 'recaptcha_v2',
      websiteURL: 'https://example.com',
      websiteKey: 'site-key',
      invisible: true,
    });

    expect(task.type).toBe('RecaptchaV2TaskProxyless');
    expect(task.isInvisible).toBe(true);
    expect(task.websiteKey).toBe('site-key');
  });

  it('builds reCAPTCHA v3 tasks with action and score', () => {
    const task = buildTwoCaptchaTask({
      type: 'recaptcha_v3',
      websiteURL: 'https://example.com/login',
      websiteKey: 'v3-key',
      action: 'login',
      minScore: 0.7,
      enterprise: true,
    });

    expect(task.type).toBe('RecaptchaV3TaskProxyless');
    expect(task.pageAction).toBe('login');
    expect(task.minScore).toBe(0.7);
    expect(task.isEnterprise).toBe(true);
  });

  it('builds hCaptcha and Turnstile tasks', () => {
    expect(
      buildTwoCaptchaTask({
        type: 'hcaptcha',
        websiteURL: 'https://example.com',
        websiteKey: 'h-key',
      }).type,
    ).toBe('HCaptchaTaskProxyless');

    expect(
      buildTwoCaptchaTask({
        type: 'turnstile',
        websiteURL: 'https://example.com',
        websiteKey: 't-key',
      }).type,
    ).toBe('TurnstileTaskProxyless');
  });

  it('attaches proxy fields when a proxy URL is provided', () => {
    const task = buildTwoCaptchaTask({
      type: 'recaptcha_v2',
      websiteURL: 'https://example.com',
      websiteKey: 'site-key',
      proxy: 'http://user:pass@127.0.0.1:8080',
    });

    expect(task.type).toBe('RecaptchaV2Task');
    expect(task.proxyAddress).toBe('127.0.0.1');
    expect(task.proxyPort).toBe('8080');
    expect(task.proxyLogin).toBe('user');
    expect(task.proxyPassword).toBe('pass');
  });
});

describe('buildCapSolverTask', () => {
  it('builds CapSolver task types for supported providers', () => {
    expect(
      buildCapSolverTask({
        type: 'recaptcha_v2',
        websiteURL: 'https://example.com',
        websiteKey: 'k',
      }).type,
    ).toBe('ReCaptchaV2TaskProxyLess');

    expect(
      buildCapSolverTask({
        type: 'recaptcha_v3',
        websiteURL: 'https://example.com',
        websiteKey: 'k',
        action: 'login',
      }).pageAction,
    ).toBe('login');

    expect(
      buildCapSolverTask({
        type: 'turnstile',
        websiteURL: 'https://example.com',
        websiteKey: 'k',
      }).type,
    ).toBe('AntiTurnstileTaskProxyLess');
  });
});
