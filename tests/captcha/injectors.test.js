import { describe, expect, it, vi } from 'vitest';
import { injectCaptchaToken } from '../../src/captcha/injectors.js';
import { CaptchaInjectError } from '../../src/captcha/errors.js';

describe('injectCaptchaToken', () => {
  it('rejects empty tokens', async () => {
    await expect(
      injectCaptchaToken(
        { evaluate: vi.fn() },
        { type: 'recaptcha_v2', token: '' },
      ),
    ).rejects.toBeInstanceOf(CaptchaInjectError);
  });

  it('delegates injection to the page and returns metadata', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        injected: true,
        callbacksFired: 1,
        fieldsWritten: ['g-recaptcha-response'],
      })),
    };

    const result = await injectCaptchaToken(page, {
      type: 'recaptcha_v2',
      token: 'token-value',
      sitekey: 'site-key',
    });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(result.fieldsWritten).toContain('g-recaptcha-response');
    expect(result.callbacksFired).toBe(1);
  });

  it('fails when the page reports no fields written', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        injected: false,
        callbacksFired: 0,
        fieldsWritten: [],
      })),
    };

    await expect(
      injectCaptchaToken(page, { type: 'turnstile', token: 'abc' }),
    ).rejects.toBeInstanceOf(CaptchaInjectError);
  });
});
