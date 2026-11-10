import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CaptchaBypass } from '../../src/captcha/captcha-bypass.js';
import { CaptchaConfigError } from '../../src/captcha/errors.js';
import * as detectors from '../../src/captcha/detectors.js';
import * as injectors from '../../src/captcha/injectors.js';
import * as solvers from '../../src/captcha/solvers/index.js';

describe('CaptchaBypass.solve', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requires an API key because stealth alone cannot mint tokens', async () => {
    const bypass = new CaptchaBypass({ apiKey: null, solver: '2captcha' });
    await expect(bypass.solve({ url: () => 'https://example.com' })).rejects.toBeInstanceOf(
      CaptchaConfigError,
    );
  });

  it('detects, solves, injects, and does not click a checkbox', async () => {
    vi.spyOn(detectors, 'detectCaptcha').mockResolvedValue({
      type: 'recaptcha_v2',
      sitekey: '6Le-test',
      invisible: false,
      enterprise: false,
      action: null,
      apiDomain: 'www.google.com',
      evidence: ['probe:recaptcha_v2'],
    });
    vi.spyOn(detectors, 'hasVisibleChallenge').mockResolvedValue(true);
    vi.spyOn(solvers, 'solveCaptcha').mockResolvedValue({
      token: 'solved-token',
      provider: '2captcha',
      taskId: 1,
    });
    vi.spyOn(injectors, 'injectCaptchaToken').mockResolvedValue({
      injected: true,
      callbacksFired: 1,
      fieldsWritten: ['g-recaptcha-response'],
    });

    const page = {
      url: () => 'https://www.google.com/recaptcha/api2/demo',
      locator: vi.fn(() => ({
        first: () => ({
          click: vi.fn(async () => {
            throw new Error('checkbox must not be clicked during token injection');
          }),
        }),
      })),
    };

    const bypass = new CaptchaBypass({
      apiKey: 'test-key',
      solver: '2captcha',
      humanize: false,
      maxRetries: 0,
    });

    const result = await bypass.solve(page, { type: 'recaptcha_v2' });

    expect(result.solved).toBe(true);
    expect(result.token).toBe('solved-token');
    expect(result.provider).toBe('2captcha');
    expect(result.sitekey).toBe('6Le-test');
    expect(solvers.solveCaptcha).toHaveBeenCalledWith(
      '2captcha',
      expect.objectContaining({
        websiteKey: '6Le-test',
        type: 'recaptcha_v2',
      }),
    );
    expect(injectors.injectCaptchaToken).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ token: 'solved-token', type: 'recaptcha_v2' }),
    );
  });

  it('retries on solver failure then succeeds', async () => {
    vi.spyOn(detectors, 'detectCaptcha').mockResolvedValue({
      type: 'recaptcha_v3',
      sitekey: 'v3-key',
      invisible: false,
      enterprise: false,
      action: 'login',
      apiDomain: null,
      evidence: ['probe:recaptcha_v3'],
    });
    vi.spyOn(detectors, 'hasVisibleChallenge').mockResolvedValue(false);

    const solveSpy = vi
      .spyOn(solvers, 'solveCaptcha')
      .mockRejectedValueOnce(new Error('temporary provider error'))
      .mockResolvedValueOnce({
        token: 'v3-token',
        provider: 'capsolver',
        taskId: 'abc',
      });

    vi.spyOn(injectors, 'injectCaptchaToken').mockResolvedValue({
      injected: true,
      callbacksFired: 0,
      fieldsWritten: ['g-recaptcha-response'],
    });

    const bypass = new CaptchaBypass({
      apiKey: 'test-key',
      solver: 'capsolver',
      humanize: false,
      maxRetries: 1,
    });

    const result = await bypass.solve(
      { url: () => 'https://example.com/login' },
      { type: 'recaptcha_v3', action: 'login', minScore: 0.7 },
    );

    expect(result.solved).toBe(true);
    expect(result.attempts).toBe(2);
    expect(solveSpy).toHaveBeenCalledTimes(2);
  });
});
