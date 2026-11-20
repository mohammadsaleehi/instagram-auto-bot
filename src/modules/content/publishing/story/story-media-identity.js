import { STORY_FAILURE_CODES } from './story-states.js';

/**
 * Preview identity verification.
 *
 * The editor preview is captured through CDP `Page.captureScreenshot` with a
 * clip equal to the visible canvas box. The captured PNG and the original
 * source image are decoded inside the page and compared as 16×16 RGB
 * fingerprints (cover and contain). This avoids canvas taint and never uses
 * `page.screenshot()`.
 */

export const DEFAULT_IDENTITY_MAX_DISTANCE = 24;

/**
 * @param {import('playwright').CDPSession} cdp
 * @param {{x: number, y: number, width: number, height: number}} box
 * @returns {Promise<string>} base64 PNG
 */
export async function captureClipScreenshot(cdp, box) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.max(1, box.width),
      height: Math.max(1, box.height),
      scale: 1,
    },
  });
  return data;
}

/**
 * Compute a 16×16 fingerprint of an image data URL and another image data URL
 * inside the live page. Returns mean absolute RGB error for cover/contain.
 *
 * @param {import('playwright').Page} page
 * @param {{targetBase64: string, targetMime?: string, sourceBase64: string, sourceMime?: string}} input
 * @returns {Promise<{ok: boolean, distance: number|null, cover: number|null, contain: number|null, reason?: string}>}
 */
export async function compareImagesInPage(page, input) {
  try {
    return await page.evaluate(
      async ({ target, source }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image decode failed'));
            img.src = src;
          });

        const fingerprint = (img, mode) => {
          const size = 16;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('2d context unavailable');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, size, size);
          const iw = img.naturalWidth || img.width;
          const ih = img.naturalHeight || img.height;
          if (!iw || !ih) throw new Error('image has no dimensions');
          const scale =
            mode === 'cover' ? Math.max(size / iw, size / ih) : Math.min(size / iw, size / ih);
          const dw = iw * scale;
          const dh = ih * scale;
          const dx = (size - dw) / 2;
          const dy = (size - dh) / 2;
          ctx.drawImage(img, dx, dy, dw, dh);
          return ctx.getImageData(0, 0, size, size).data;
        };

        const mae = (a, b) => {
          let sum = 0;
          let channels = 0;
          for (let i = 0; i < a.length; i += 4) {
            sum += Math.abs(a[i] - b[i]);
            sum += Math.abs(a[i + 1] - b[i + 1]);
            sum += Math.abs(a[i + 2] - b[i + 2]);
            channels += 3;
          }
          return sum / channels;
        };

        try {
          const [targetImg, sourceImg] = await Promise.all([load(target), load(source)]);
          const cover = mae(fingerprint(targetImg, 'cover'), fingerprint(sourceImg, 'cover'));
          const contain = mae(fingerprint(targetImg, 'contain'), fingerprint(sourceImg, 'contain'));
          return {
            ok: true,
            cover: Number(cover.toFixed(2)),
            contain: Number(contain.toFixed(2)),
            distance: Number(Math.min(cover, contain).toFixed(2)),
          };
        } catch (error) {
          return {
            ok: false,
            distance: null,
            cover: null,
            contain: null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        target: `data:${input.targetMime ?? 'image/png'};base64,${input.targetBase64}`,
        source: `data:${input.sourceMime ?? 'image/jpeg'};base64,${input.sourceBase64}`,
      },
    );
  } catch (error) {
    return {
      ok: false,
      distance: null,
      cover: null,
      contain: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {{
 *   cdp: import('playwright').CDPSession,
 *   page: import('playwright').Page,
 *   canvasBox: {x: number, y: number, width: number, height: number},
 *   sourceBase64: string,
 *   sourceMime?: string,
 *   maxDistance?: number,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   failureCode: string|null,
 *   reason?: string,
 *   distance?: number|null,
 *   cover?: number|null,
 *   contain?: number|null,
 *   clipBase64?: string,
 * }>}
 */
export async function verifyPreviewIdentity(input) {
  let clipBase64;
  try {
    clipBase64 = await captureClipScreenshot(input.cdp, input.canvasBox);
  } catch (error) {
    return {
      ok: false,
      failureCode: STORY_FAILURE_CODES.PREVIEW_IDENTITY_UNVERIFIABLE,
      reason: `preview-clip-failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const compared = await compareImagesInPage(input.page, {
    targetBase64: clipBase64,
    targetMime: 'image/png',
    sourceBase64: input.sourceBase64,
    sourceMime: input.sourceMime ?? 'image/jpeg',
  });

  if (!compared.ok) {
    return {
      ok: false,
      failureCode: STORY_FAILURE_CODES.PREVIEW_IDENTITY_UNVERIFIABLE,
      reason: compared.reason,
      clipBase64,
    };
  }

  const maxDistance = input.maxDistance ?? DEFAULT_IDENTITY_MAX_DISTANCE;
  const ok = compared.distance != null && compared.distance <= maxDistance;
  return {
    ok,
    failureCode: ok ? null : STORY_FAILURE_CODES.PREVIEW_IDENTITY_MISMATCH,
    reason: ok ? undefined : `preview-distance:${compared.distance}>${maxDistance}`,
    distance: compared.distance,
    cover: compared.cover,
    contain: compared.contain,
    clipBase64,
  };
}

/**
 * Optional evidence only: read the largest visible canvas into a 16×16
 * fingerprint. Canvas taint is reported, not thrown.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ok: boolean, reason?: string, fingerprint?: number[]}>}
 */
export async function readCanvasFingerprint(page) {
  try {
    return await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'))
        .filter((canvas) => canvas.width > 0 && canvas.height > 0)
        .sort((a, b) => b.width * b.height - a.width * a.height);
      const canvas = canvases[0];
      if (!canvas) return { ok: false, reason: 'no-canvas' };
      const size = 16;
      const small = document.createElement('canvas');
      small.width = size;
      small.height = size;
      const ctx = small.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      return { ok: true, fingerprint: Array.from(data) };
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
