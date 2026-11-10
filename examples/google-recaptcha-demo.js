/**
 * Acceptance demo against Google's public reCAPTCHA v2 checkbox page.
 *
 * Requirements:
 * - CAPTCHA_API_KEY in the environment
 * - CAPTCHA_SOLVER=2captcha|capsolver (default 2captcha)
 *
 * This script will NOT fake success. If the API key is missing or the provider
 * rejects the task, it exits non-zero with the real error.
 *
 * Usage:
 *   CAPTCHA_API_KEY=... node examples/google-recaptcha-demo.js
 */

import { CaptchaBypass } from '../src/captcha/index.js';

const DEMO_URL = 'https://www.google.com/recaptcha/api2/demo';

async function main() {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          'CAPTCHA_API_KEY is required. Refusing to fake a successful captcha solve.',
      }),
    );
    process.exitCode = 1;
    return;
  }

  const bypass = new CaptchaBypass({
    solver: process.env.CAPTCHA_SOLVER === 'capsolver' ? 'capsolver' : '2captcha',
    apiKey,
    headless: process.env.HEADLESS === 'true',
    proxy: process.env.PROXY || null,
    timeoutMs: Number(process.env.CAPTCHA_TIMEOUT_MS || 120000),
    maxRetries: 1,
    humanize: true,
    browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || null,
  });

  try {
    const { page } = await bypass.launch();
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    const result = await bypass.solve(page, {
      type: 'recaptcha_v2',
      submitSelector: '#recaptcha-demo-submit',
    });

    // Google's demo shows a success banner when the token is accepted.
    const successVisible = await page
      .locator('.recaptcha-success, .alert-success, text=/Success/i')
      .first()
      .isVisible()
      .catch(() => false);

    console.log(
      JSON.stringify(
        {
          ok: Boolean(result.solved && successVisible),
          solved: result.solved,
          provider: result.provider,
          type: result.type,
          attempts: result.attempts,
          sitekeyPrefix: result.sitekey ? `${result.sitekey.slice(0, 6)}…` : null,
          demoSuccessBannerVisible: successVisible,
          note: successVisible
            ? 'Google demo accepted the injected token.'
            : 'Token was injected, but the demo success banner was not observed. Inspect the open page.',
        },
        null,
        2,
      ),
    );

    if (!result.solved || !successVisible) {
      process.exitCode = 1;
    }

    // Keep the browser briefly for visual confirmation when headed.
    if (process.env.HEADLESS !== 'true') {
      await page.waitForTimeout(3_000);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await bypass.close();
  }
}

main();
