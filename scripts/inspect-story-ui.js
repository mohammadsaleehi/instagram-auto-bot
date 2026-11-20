#!/usr/bin/env node
/**
 * Opt-in diagnostic: attach to existing Chrome, inspect Instagram home chrome
 * for Create / Story controls. NEVER uploads media or clicks Share.
 *
 * Usage: node scripts/inspect-story-ui.js
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { BrowserManager } from '../src/browser/browser-manager.js';
import { detectAuthState } from '../src/auth/auth-state.js';
import { createLogger } from '../src/utils/logger.js';

const OUT_DIR = path.resolve(process.cwd(), 'data/diagnostics/story-ui');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel ?? 'info' });
  const browserManager = new BrowserManager({
    mode: config.browserMode,
    cdpEndpoint: config.browserCdpEndpoint,
    browserChannel: config.browserChannel,
    headless: config.headless,
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
    userDataDir: config.userDataDir,
    navigationTimeoutMs: config.navigationTimeoutMs,
    logger,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(OUT_DIR, `${stamp}-live-inspect`);

  let page;
  try {
    page = await browserManager.start();
    const baseUrl = String(config.instagramBaseUrl ?? 'https://www.instagram.com').replace(
      /\/$/,
      '',
    );
    await page.goto(`${baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs,
    });
    await page.waitForTimeout(2500);

    const auth = await detectAuthState(page);
    const viewport = page.viewportSize();

    const summary = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], svg[aria-label], [aria-label], nav *',
        ),
      );
      const allLabeled = nodes
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          aria: (el.getAttribute('aria-label') || '').slice(0, 120),
          text: ((/** @type {HTMLElement} */ (el).innerText || '').trim()).slice(0, 80),
          href: (el.getAttribute('href') || '').slice(0, 120),
          visible: (() => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0
            );
          })(),
        }))
        .filter((row) => row.aria || row.text || row.href);

      const createish = allLabeled.filter((row) =>
        /create|new\s*post|story|share|select|reel|plus|\+/i.test(
          `${row.aria} ${row.text} ${row.href}`,
        ),
      );

      const ariaLabels = [
        ...new Set(
          Array.from(document.querySelectorAll('[aria-label], svg[aria-label]'))
            .map((el) => el.getAttribute('aria-label') || '')
            .filter(Boolean),
        ),
      ].slice(0, 200);

      return {
        url: location.href,
        lang: document.documentElement.lang || null,
        title: document.title.slice(0, 160),
        bodyDir: document.body?.dir || null,
        fileInputCount: document.querySelectorAll('input[type="file"]').length,
        dialogCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
        ariaLabels,
        createish: createish.slice(0, 100),
        navSample: allLabeled.filter((r) => r.visible).slice(0, 60),
      };
    });

    // Probe role-based locators without clicking Share / uploading.
    const probes = {};
    for (const name of [/new\s*post/i, /^create$/i, /create/i, /your\s*story/i, /^story$/i]) {
      const key = String(name);
      probes[key] = {
        link: await page.getByRole('link', { name }).count(),
        button: await page.getByRole('button', { name }).count(),
      };
    }
    for (const label of ['New post', 'Create', 'New Post', 'Home', 'Search', 'Create post']) {
      probes[`svg[aria-label="${label}"]`] = await page
        .locator(`svg[aria-label="${label}"]`)
        .count();
      probes[`[aria-label="${label}"]`] = await page.locator(`[aria-label="${label}"]`).count();
    }
    probes['a[href*="/create"]'] = await page.locator('a[href*="/create"]').count();
    probes['text Create'] = await page.getByText(/^Create$/i).count();

    await page.screenshot({ path: `${base}.png`, fullPage: false });

    const payload = {
      capturedAt: new Date().toISOString(),
      authState: auth.state,
      authReason: auth.reason,
      authSignals: auth.signals,
      viewport,
      browserMode: config.browserMode,
      probes,
      ...summary,
      note: 'Inspection only — no upload, no Share click.',
    };
    await fs.writeFile(`${base}.json`, JSON.stringify(payload, null, 2));
    console.log(
      JSON.stringify(
        {
          ok: true,
          authState: auth.state,
          url: summary.url,
          lang: summary.lang,
          screenshot: `${base}.png`,
          json: `${base}.json`,
          createishCount: summary.createish.length,
          probes,
        },
        null,
        2,
      ),
    );
  } finally {
    // existing mode: disconnect without closing user's Chrome
    await browserManager.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code,
    }),
  );
  process.exitCode = 1;
});
