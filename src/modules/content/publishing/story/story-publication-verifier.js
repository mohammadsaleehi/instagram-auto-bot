import { promises as fs } from 'node:fs';
import { compareImagesInPage, captureClipScreenshot } from './story-media-identity.js';
import { redactText, redactUrl } from './story-diagnostics.js';

/**
 * Read-only verification of the account's own Story.
 *
 * This module never creates content. It navigates to the authenticated
 * account's profile, opens the Story ring if one appears, and inspects the
 * viewer. It never clicks "Your story", the Story tray, Create, or Share.
 */

/**
 * Read the authenticated account handle from the bottom navigation avatar.
 * The avatar is the only profile link in the bottom 15% of the viewport; feed
 * avatars sit near the top.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
export async function readAccountHandle(page) {
  return page.evaluate(() => {
    const candidates = [];
    for (const img of Array.from(document.querySelectorAll('img[alt]'))) {
      const alt = img.getAttribute('alt') || '';
      if (!/profile picture/i.test(alt)) continue;
      const link = img.closest('a[href]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9._]{1,30})\/$/);
      if (!match) continue;
      const r = link.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      if (r.y < window.innerHeight * 0.85) continue;
      candidates.push(match[1]);
    }
    return candidates[0] ?? null;
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} handle
 * @returns {Promise<{
 *   ok: boolean,
 *   url: string,
 *   ringCount: number,
 *   rings: Array<{href:string,x:number,y:number,w:number,h:number}>,
 *   storyIds: string[],
 *   avatarHasRing: boolean,
 *   orientation: string|null,
 *   reason?: string,
 * }>}
 */
export async function captureOwnStoryBaseline(page, handle) {
  const profileUrl = `https://www.instagram.com/${handle}/`;
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2_500);
  } catch (error) {
    return {
      ok: false,
      url: redactUrl(page.url()),
      ringCount: 0,
      rings: [],
      storyIds: [],
      avatarHasRing: false,
      orientation: null,
      reason: `profile-navigation-failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const profile = await page.evaluate((accountHandle) => {
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const linkRings = Array.from(document.querySelectorAll('a[href*="/stories/"]'))
      .filter((a) => !/\/archive\//i.test(a.getAttribute('href') || ''))
      .map((a) => ({
        kind: 'link',
        href: a.getAttribute('href') || '',
        aria: a.getAttribute('aria-label'),
        ...boxOf(a),
      }))
      .filter((ring) => ring.w > 0 && ring.h > 0);
    const buttonRings = Array.from(
      document.querySelectorAll('[role="button"][aria-label]'),
    )
      .filter((el) => {
        const aria = el.getAttribute('aria-label') || '';
        return (
          new RegExp(`^Story by ${accountHandle}\\b`, 'i').test(aria) ||
          /^Your story$/i.test(aria)
        );
      })
      .map((el) => ({
        kind: 'button',
        href: null,
        aria: el.getAttribute('aria-label'),
        ...boxOf(el),
      }))
      .filter((ring) => ring.w > 0 && ring.h > 0);
    const rings = [...linkRings, ...buttonRings];
    const storyIds = linkRings
      .map((ring) => ring.href.match(/\/stories\/[^/]+\/(\d+)/)?.[1] ?? null)
      .filter(Boolean);
    const avatar = Array.from(document.querySelectorAll('img[alt*="profile picture" i]')).find(
      (img) => (img.getBoundingClientRect().y ?? 0) > 0,
    );
    const avatarParent = avatar?.closest('a,button,[role="button"]');
    const avatarHasRing = Boolean(
      avatarParent &&
        (avatarParent.querySelector('canvas') ||
          /story|stories/i.test(avatarParent.getAttribute('aria-label') || '')),
    );
    return {
      rings,
      storyIds,
      avatarHasRing,
      orientation: screen.orientation?.type ?? null,
    };
  }, handle);

  return {
    ok: true,
    url: redactUrl(page.url()),
    ringCount: profile.rings.length,
    rings: profile.rings,
    storyIds: profile.storyIds,
    avatarHasRing: profile.avatarHasRing,
    orientation: profile.orientation,
  };
}

/**
 * Observe the editor immediately after the single Share click. This is
 * evidence, not confirmation: only the independent account check confirms.
 *
 * @param {import('playwright').Page} page
 * @param {{ timeoutMs?: number, stepMs?: number }} [options]
 * @returns {Promise<{leftEditor: boolean, url: string, elapsedMs: number, bodySnippet: string}>}
 */
export async function observeAfterShare(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const stepMs = options.stepMs ?? 1_000;
  const started = Date.now();
  let lastUrl = page.url();
  while (Date.now() - started < timeoutMs) {
    lastUrl = page.url();
    if (!/\/create\/story\/?/i.test(lastUrl)) {
      return {
        leftEditor: true,
        url: redactUrl(lastUrl),
        elapsedMs: Date.now() - started,
        bodySnippet: await readBodySnippet(page),
      };
    }
    await page.waitForTimeout(stepMs);
  }
  return {
    leftEditor: false,
    url: redactUrl(lastUrl),
    elapsedMs: Date.now() - started,
    bodySnippet: await readBodySnippet(page),
  };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readBodySnippet(page) {
  try {
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 600));
    return redactText(text);
  } catch {
    return '';
  }
}

/**
 * Independent, read-only confirmation that the Story appears on the account.
 *
 * It polls the profile for a Story ring, opens the viewer, captures the story
 * id from the viewer URL, and compares the visible viewer media with the
 * source image. It does not click Create/Share/Your story.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   cdp: import('playwright').CDPSession,
 *   handle: string,
 *   sourceFilePath: string,
 *   sourceMime: string,
 *   timeoutMs?: number,
 *   baselineStoryIds?: string[],
 *   expectedStoryId?: string|null,
 *   maxIdentityDistance?: number,
 *   onViewer?: (input: {
 *     page: import('playwright').Page,
 *     cdp: import('playwright').CDPSession,
 *     viewer: Record<string, any>,
 *   }) => Promise<void>|void,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   appeared: boolean,
 *   viewerOpened: boolean,
 *   storyId: string|null,
 *   storyIds: string[],
 *   timeLabels: string[],
 *   identity: {ok:boolean, distance:number|null, cover:number|null, contain:number|null, reason?:string}|null,
 *   profileUrl: string,
 *   viewerUrl: string|null,
 *   viewerMedia: Record<string, unknown>|null,
 *   reason?: string,
 * }>}
 */
export async function verifyPublicationOnAccount(input) {
  const timeoutMs = input.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  const profileUrl = `https://www.instagram.com/${input.handle}/`;
  const baselineStoryIds = new Set(input.baselineStoryIds ?? []);
  const maxIdentityDistance = input.maxIdentityDistance ?? 32;
  let lastRings = [];
  let lastReason = 'no-story-ring';

  const sourceBase64 = await fs.readFile(input.sourceFilePath, { encoding: 'base64' });

  while (Date.now() < deadline) {
    try {
      await input.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await input.page.waitForTimeout(2_000);
    } catch (error) {
      lastReason = `profile-navigation-failed:${error instanceof Error ? error.message : String(error)}`;
      await input.page.waitForTimeout(3_000);
      continue;
    }

    const collectRings = (accountHandle) => {
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      const linkRings = Array.from(document.querySelectorAll('a[href*="/stories/"]'))
        .filter((a) => !/\/archive\//i.test(a.getAttribute('href') || ''))
        .map((a) => ({
          kind: 'link',
          href: a.getAttribute('href') || '',
          aria: a.getAttribute('aria-label'),
          ...boxOf(a),
        }))
        .filter((ring) => ring.w > 0 && ring.h > 0);
      const buttonRings = Array.from(
        document.querySelectorAll('[role="button"][aria-label]'),
      )
        .filter((el) => {
          const aria = el.getAttribute('aria-label') || '';
          return new RegExp(`^Story by ${accountHandle}\\b`, 'i').test(aria);
        })
        .map((el) => ({
          kind: 'button',
          href: null,
          aria: el.getAttribute('aria-label'),
          ...boxOf(el),
        }))
        .filter((ring) => ring.w > 0 && ring.h > 0);
      return [...linkRings, ...buttonRings];
    };

    let rings = await input.page.evaluate(collectRings, input.handle);
    if (rings.length === 0) {
      // The active own-Story tray button is reliably present on the home feed
      // even when the profile does not render an anchor ring.
      try {
        await input.page.goto('https://www.instagram.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await input.page.waitForTimeout(2_000);
        rings = await input.page.evaluate(collectRings, input.handle);
      } catch (error) {
        lastReason = `home-fallback-failed:${error instanceof Error ? error.message : String(error)}`;
      }
    }
    lastRings = rings;
    const storyIds = rings
      .filter((ring) => ring.kind === 'link')
      .map((ring) => ring.href.match(/\/stories\/[^/]+\/(\d+)/)?.[1] ?? null)
      .filter(Boolean);

    const expected = input.expectedStoryId ?? null;
    const candidate = expected
      ? rings.find((ring) => ring.kind === 'link' && ring.href.includes(expected))
      : rings.find((ring) => {
          if (ring.kind !== 'link') return false;
          const id = ring.href.match(/\/stories\/[^/]+\/(\d+)/)?.[1];
          return id && !baselineStoryIds.has(id);
        }) ?? rings.find((ring) => ring.kind === 'button');

    if (!candidate) {
      lastReason = rings.length
        ? 'only-preexisting-story-rings'
        : 'no-story-ring';
      await input.page.waitForTimeout(3_000);
      continue;
    }

    try {
      if (candidate.kind === 'link') {
        await input.page
          .locator(`a[href="${candidate.href}"]`)
          .first()
          .click({ timeout: 8_000 });
      } else {
        await input.page
          .getByRole('button', { name: candidate.aria, exact: true })
          .first()
          .click({ timeout: 8_000 });
      }
      await input.page.waitForTimeout(2_500);
    } catch (error) {
      lastReason = `story-ring-click-failed:${error instanceof Error ? error.message : String(error)}`;
      await input.page.keyboard.press('Escape').catch(() => {});
      await input.page.waitForTimeout(2_000);
      continue;
    }

    const viewer = await input.page.evaluate(() => {
      const path = location.pathname;
      const match = path.match(/^\/stories\/[^/]+\/(\d+)/);
      const storyId = match?.[1] ?? null;
      const viewerPathOk = /^\/stories\//.test(path);
      const media = Array.from(document.querySelectorAll('img, video'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          const visible =
            r.width > 0 &&
            r.height > 0 &&
            getComputedStyle(el).visibility !== 'hidden' &&
            getComputedStyle(el).display !== 'none';
          return {
            tag: el.tagName,
            box: {
              x: Math.max(0, Math.round(r.x)),
              y: Math.max(0, Math.round(r.y)),
              width: Math.round(r.width),
              height: Math.round(r.height),
            },
            visible,
            area: Math.round(r.width * r.height),
            naturalWidth: el.naturalWidth ?? el.videoWidth ?? 0,
            naturalHeight: el.naturalHeight ?? el.videoHeight ?? 0,
            srcHost: (() => {
              try {
                return new URL(el.currentSrc || el.src || '', location.href).host;
              } catch {
                return null;
              }
            })(),
            dataUrl: (() => {
              if (el.tagName !== 'IMG' || !el.complete || !el.naturalWidth) return null;
              try {
                const c = document.createElement('canvas');
                c.width = 16;
                c.height = 16;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(el, 0, 0, 16, 16);
                return c.toDataURL('image/png');
              } catch {
                return null;
              }
            })(),
          };
        })
        .filter((m) => m.visible && m.area > 10_000 && m.naturalWidth >= 100)
        .sort((a, b) => b.area - a.area);
      const timeLabels = Array.from(document.querySelectorAll('div, span'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.innerText || '').trim();
          return { text, y: r.y, h: r.height, w: r.width };
        })
        .filter(
          (item) =>
            item.h > 0 &&
            item.w > 0 &&
            item.y < 140 &&
            /^(now|just now|\d+\s*[smhd])$/i.test(item.text),
        )
        .map((item) => item.text)
        .slice(0, 5);
      if (timeLabels.length === 0) {
        const fallback = (document.body?.innerText || '').match(
          /\b(now|just now|\d+\s*[smhd])\b/i,
        );
        if (fallback) timeLabels.push(fallback[1]);
      }
      return {
        storyId,
        viewerPathOk,
        url: location.href,
        orientation: screen.orientation?.type ?? null,
        media: media[0] ?? null,
        timeLabels,
        bodySnippet: (document.body?.innerText || '').slice(0, 400),
      };
    });

    if (!viewer.viewerPathOk || !viewer.media) {
      lastReason = !viewer.viewerPathOk
        ? 'viewer-url-not-stories'
        : 'viewer-media-not-found';
      await input.page.keyboard.press('Escape').catch(() => {});
      await input.page.waitForTimeout(2_000);
      continue;
    }
    if (expected && viewer.storyId && viewer.storyId !== expected) {
      lastReason = `viewer-story-id-mismatch:${viewer.storyId}`;
      await input.page.keyboard.press('Escape').catch(() => {});
      await input.page.waitForTimeout(2_000);
      continue;
    }

    let identity = null;
    try {
      const targetBase64 = viewer.media.dataUrl
        ? viewer.media.dataUrl.replace(/^data:image\/[a-z+]+;base64,/, '')
        : await captureClipScreenshot(input.cdp, viewer.media.box);
      const compared = await compareImagesInPage(input.page, {
        targetBase64,
        targetMime: 'image/png',
        sourceBase64,
        sourceMime: input.sourceMime || 'image/jpeg',
      });
      const ok =
        compared.ok &&
        compared.distance != null &&
        compared.distance <= maxIdentityDistance;
      identity = {
        ok,
        distance: compared.distance,
        cover: compared.cover,
        contain: compared.contain,
        reason: compared.ok ? (ok ? undefined : 'distance-above-threshold') : compared.reason,
      };
    } catch (error) {
      identity = {
        ok: false,
        distance: null,
        cover: null,
        contain: null,
        reason: `viewer-identity-failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (typeof input.onViewer === 'function') {
      await input.onViewer({ page: input.page, cdp: input.cdp, viewer }).catch(() => {});
    }

    await input.page.keyboard.press('Escape').catch(() => {});
    await input.page.waitForTimeout(500);

    const confirmed = identity?.ok === true;
    return {
      ok: confirmed,
      appeared: true,
      viewerOpened: true,
      storyId: viewer.storyId,
      storyIds,
      timeLabels: viewer.timeLabels,
      identity,
      profileUrl: redactUrl(profileUrl),
      viewerUrl: redactUrl(viewer.url),
      viewerMedia: {
        tag: viewer.media.tag,
        box: viewer.media.box,
        naturalWidth: viewer.media.naturalWidth,
        naturalHeight: viewer.media.naturalHeight,
        srcHost: viewer.media.srcHost,
        usedDataUrl: Boolean(viewer.media.dataUrl),
      },
      ...(confirmed
        ? {}
        : { reason: identity?.reason ?? 'viewer-identity-not-confirmed' }),
    };
  }

  return {
    ok: false,
    appeared: lastRings.length > 0,
    viewerOpened: false,
    storyId: null,
    storyIds: lastRings
      .map((ring) => ring.href.match(/\/stories\/[^/]+\/(\d+)/)?.[1] ?? null)
      .filter(Boolean),
    timeLabels: [],
    identity: null,
    profileUrl: redactUrl(profileUrl),
    viewerUrl: null,
    viewerMedia: null,
    reason: lastReason,
  };
}

export { redactText };
