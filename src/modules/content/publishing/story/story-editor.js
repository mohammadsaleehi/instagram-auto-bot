import { promises as fs } from 'node:fs';
import { STORY_UI } from '../story-ui-selectors.js';
import { STORY_FAILURE_CODES, STORY_STATE_TIMEOUTS, StoryPublishState } from './story-states.js';
import {
  readCanvasFingerprint,
  verifyPreviewIdentity,
} from './story-media-identity.js';

/**
 * Verifies the real Instagram Story editor before any Share action.
 *
 * Ready means all of:
 * - URL is `/create/story/`
 * - portrait orientation invariant
 * - no rotate-device overlay
 * - no Create-new-post composer
 * - a visible preview canvas (>= 720×1280 backing)
 * - exactly one enabled `Add to your story` button in the bottom action bar
 * - preview identity matches the uploaded file (CDP clip fingerprint)
 * - the same evidence is observed on two consecutive polls
 */
export class StoryEditor {
  /**
   * @param {{
   *   page: import('playwright').Page,
   *   session: import('./story-browser-session.js').StoryBrowserSession,
   *   cdp: import('playwright').CDPSession,
   *   timeouts?: { stepPollMs?: number },
   *   identityMaxDistance?: number,
   *   logger?: { info?: Function, warn?: Function } | null,
   * }} options
   */
  constructor(options) {
    this.page = options.page;
    this.session = options.session;
    this.cdp = options.cdp;
    this.stepPollMs = options.timeouts?.stepPollMs ?? 400;
    this.identityMaxDistance = options.identityMaxDistance;
    this.logger = options.logger ?? null;
    /** @type {boolean} */
    this._shareDispatched = false;
  }

  /**
   * @param {{
   *   sourceFilePath: string,
   *   sourceMime: string,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   * }} input
   * @returns {Promise<{
   *   ok: boolean,
   *   failureCode: string|null,
   *   message?: string,
   *   evidence?: Record<string, unknown>,
   * }>}
   */
  async waitForReady(input) {
    const timeoutMs =
      input.timeoutMs ?? STORY_STATE_TIMEOUTS[StoryPublishState.EDITOR_LOADING];
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let previousSignature = null;
    let previousAt = 0;

    while (Date.now() < deadline) {
      this._throwIfAborted(input.signal);
      last = await this.quickCheck();
      if (!last.ok) {
        previousSignature = null;
        if (last.terminal) {
          return {
            ok: false,
            failureCode: last.failureCode,
            message: last.message,
            evidence: last.evidence,
          };
        }
        await this.page.waitForTimeout(this.stepPollMs);
        continue;
      }

      const signature = JSON.stringify({
        url: last.evidence.url,
        orientation: last.evidence.orientation,
        canvas: last.evidence.canvas,
        shareBox: last.evidence.shareBox,
      });

      if (previousSignature === signature && Date.now() - previousAt >= this.stepPollMs) {
        // Stable. Now do the expensive identity check once.
        const sourceBase64 = await fs.readFile(input.sourceFilePath, { encoding: 'base64' });
        const identity = await verifyPreviewIdentity({
          cdp: this.cdp,
          page: this.page,
          canvasBox: /** @type {{x:number,y:number,width:number,height:number}} */ (last.evidence.canvas.box),
          sourceBase64,
          sourceMime: input.sourceMime,
          maxDistance: this.identityMaxDistance,
        });

        const canvasFingerprint = await readCanvasFingerprint(this.page);
        const evidence = {
          ...last.evidence,
          identity: {
            ok: identity.ok,
            distance: identity.distance,
            cover: identity.cover,
            contain: identity.contain,
            reason: identity.reason ?? null,
          },
          canvasFingerprint: canvasFingerprint.ok
            ? { ok: true, samples: canvasFingerprint.fingerprint?.length ?? 0 }
            : { ok: false, reason: canvasFingerprint.reason },
          stableForMs: Date.now() - previousAt,
        };

        if (!identity.ok) {
          return {
            ok: false,
            failureCode: identity.failureCode,
            message: `Story preview identity could not be verified: ${identity.reason ?? 'mismatch'}`,
            evidence,
          };
        }

        // Re-check the geometry after the identity capture. CDP screenshots
        // must not have changed orientation or the action bar.
        const after = await this.quickCheck();
        if (!after.ok || JSON.stringify(after.evidence.shareBox) !== JSON.stringify(last.evidence.shareBox)) {
          previousSignature = null;
          last = after;
          await this.page.waitForTimeout(this.stepPollMs);
          continue;
        }

        return {
          ok: true,
          failureCode: null,
          evidence: {
            ...evidence,
            postIdentityOrientation: after.evidence.orientation,
            postIdentityShareBox: after.evidence.shareBox,
          },
        };
      }

      previousSignature = signature;
      previousAt = Date.now();
      await this.page.waitForTimeout(this.stepPollMs);
    }

    return {
      ok: false,
      failureCode: last?.failureCode ?? STORY_FAILURE_CODES.EDITOR_NOT_OPENED,
      message: last?.message ?? 'Story editor did not reach a stable ready state.',
      evidence: last?.evidence ?? {},
    };
  }

  /**
   * Fast readiness checks. Terminal failures stop the loop; transient ones
   * (canvas not painted yet) are retried.
   *
   * @returns {Promise<{
   *   ok: boolean,
   *   failureCode: string|null,
   *   message?: string,
   *   terminal?: boolean,
   *   evidence: Record<string, any>,
   * }>}
   */
  async quickCheck() {
    const env = await this.session.environment();
    const url = this.page.url();
    const evidence = {
      url,
      orientation: env.screenOrientation,
      viewport: { width: env.innerWidth, height: env.innerHeight },
      shareBox: null,
      canvas: null,
    };

    if (env.screenOrientation !== 'portrait-primary') {
      return {
        ok: false,
        terminal: true,
        failureCode: STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT,
        message: `Story editor orientation is ${env.screenOrientation ?? 'unknown'}, expected portrait-primary.`,
        evidence,
      };
    }

    if (await this.session.hasHumanBlockers()) {
      return {
        ok: false,
        terminal: true,
        failureCode: STORY_FAILURE_CODES.CHECKPOINT_REQUIRED,
        message: 'Instagram challenge or verification appeared in the Story editor.',
        evidence,
      };
    }

    if (await this.session.hasRotateOverlay()) {
      return {
        ok: false,
        terminal: true,
        failureCode: STORY_FAILURE_CODES.ROTATE_OVERLAY_PRESENT,
        message: 'Instagram shows the rotate-device warning; the editor is not usable.',
        evidence,
      };
    }

    if (!/\/create\/story\/?/i.test(url)) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.EDITOR_URL_INVALID,
        message: `Story editor URL is not /create/story/ (got ${url}).`,
        evidence,
      };
    }

    const postComposerSource = STORY_UI.postComposerText.map((re) => re.source).join('|');
    const postComposer = await this.page.evaluate(
      (source) =>
        new RegExp(source, 'i').test((document.body?.innerText || '').slice(0, 4000)),
      postComposerSource,
    );
    if (postComposer) {
      return {
        ok: false,
        terminal: true,
        failureCode: STORY_FAILURE_CODES.POST_COMPOSER_OPEN,
        message: 'Instagram opened the Create-new-post composer instead of the Story editor.',
        evidence,
      };
    }

    const canvas = await this._findPreviewCanvas();
    evidence.canvas = canvas;
    if (!canvas) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.PREVIEW_CANVAS_MISSING,
        message: 'Story editor is open but no visible preview canvas is painted yet.',
        evidence,
      };
    }

    const share = await this._findShareControl();
    evidence.shareBox = share.box;
    evidence.shareControl = share.details;
    if (!share.ok) {
      return {
        ok: false,
        terminal: share.terminal === true,
        failureCode: share.failureCode,
        message: share.message,
        evidence,
      };
    }

    return { ok: true, failureCode: null, evidence };
  }

  /**
   * @returns {Promise<{x:number,y:number,width:number,height:number,backing:{width:number,height:number},index:number}|null>}
   */
  async _findPreviewCanvas() {
    try {
      return await this.page.evaluate(() => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const candidates = Array.from(document.querySelectorAll('canvas'))
          .map((canvas, index) => {
            const r = canvas.getBoundingClientRect();
            const style = getComputedStyle(canvas);
            const visible =
              r.width > 0 &&
              r.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              Number(style.opacity || '1') > 0;
            const intersects =
              r.right > 0 &&
              r.bottom > 0 &&
              r.left < viewport.width &&
              r.top < viewport.height;
            return {
              index,
              visible,
              intersects,
              box: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
              },
              backing: { width: canvas.width, height: canvas.height },
              area: Math.round(r.width * r.height),
            };
          })
          .filter((c) => c.visible && c.intersects)
          .filter((c) => c.backing.width >= 720 && c.backing.height >= 1280)
          .sort((a, b) => (b.area - a.area) || (a.index - b.index));
        return candidates[0] ?? null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Exact enabled `Add to your story` button in the bottom action bar.
   *
   * @returns {Promise<{
   *   ok: boolean,
   *   terminal?: boolean,
   *   failureCode: string|null,
   *   message?: string,
   *   box?: {x:number,y:number,width:number,height:number}|null,
   *   details?: Record<string, unknown>,
   * }>}
   */
  async _findShareControl(options = {}) {
    const keepMarker = options.keepMarker === true;
    let marked = false;
    try {
      // Live Instagram wraps the label with an icon; the accessible name can
      // include that icon text. Select the one visible row whose own trimmed
      // text is exactly the label, then validate it through Playwright.
      const found = await this.page.evaluate((shareLabel) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const rows = Array.from(
          document.querySelectorAll('button, [role="button"], [role="menuitem"]'),
        );
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || '1') > 0
          );
        };
        const exact = rows.filter(
          (el) => (el.innerText || '').trim().toLowerCase() === shareLabel,
        );
        const matches = exact
          .filter(isVisible)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              role: el.getAttribute('role'),
              text: (el.innerText || '').trim(),
              aria: el.getAttribute('aria-label'),
              disabled:
                el.disabled === true || el.getAttribute('aria-disabled') === 'true',
              box: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
              },
            };
          });
        if (matches.length === 1) {
          exact.filter(isVisible)[0]?.setAttribute('data-op-story-share', '1');
        }
        return { matches, viewport };
      }, STORY_UI.exactShareButtonText.toLowerCase());

      const count = found.matches.length;
      if (count === 0) {
        return {
          ok: false,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
          message: 'Enabled "Add to your story" button is not present in the editor.',
        };
      }
      if (count > 1) {
        return {
          ok: false,
          terminal: true,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
          message: `Multiple "Add to your story" buttons found (${count}).`,
        };
      }

      marked = true;
      const target = this.page.locator('[data-op-story-share="1"]').first();
      if ((await target.count()) !== 1 || !(await target.isVisible({ timeout: 500 }))) {
        return {
          ok: false,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
          message: '"Add to your story" button is not visible.',
        };
      }
      if (!(await target.isEnabled())) {
        return {
          ok: false,
          terminal: true,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_DISABLED,
          message: '"Add to your story" button is disabled.',
        };
      }
      const box = await target.boundingBox();
      if (!box) {
        return {
          ok: false,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_GEOMETRY_INVALID,
          message: '"Add to your story" button has no bounding box.',
        };
      }
      const inBottomBar =
        box.y > found.viewport.height * 0.65 &&
        box.y + box.height > found.viewport.height * 0.75;
      if (!inBottomBar || box.width < 40 || box.height < 16) {
        return {
          ok: false,
          terminal: true,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_GEOMETRY_INVALID,
          message: '"Add to your story" button is not in the bottom action bar.',
          box: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
        };
      }
      return {
        ok: true,
        failureCode: null,
        box: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        details: {
          count,
          enabled: true,
          inBottomBar,
          tag: found.matches[0].tag,
          role: found.matches[0].role,
          text: found.matches[0].text,
          aria: found.matches[0].aria,
        },
      };
    } catch (error) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
        message: `Share control lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (marked && !keepMarker) {
        await this._cleanupShareMarker();
      }
    }
  }

  /**
   * Click the verified Share control exactly once. The caller must have
   * already persisted the durable Share intent. A thrown click is reported as
   * `unknown`, never retried here.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   dispatched: boolean|'unknown',
   *   failureCode?: string,
   *   message?: string,
   *   box?: Record<string, number>,
   *   details?: Record<string, unknown>,
   * }>}
   */
  async clickShareOnce(options = {}) {
    this._throwIfAborted(options.signal);
    if (this._shareDispatched) {
      return {
        ok: false,
        dispatched: false,
        failureCode: STORY_FAILURE_CODES.SHARE_ALREADY_RECORDED,
        message: 'Share was already dispatched once; refusing a second click.',
      };
    }

    const found = await this._findShareControl({ keepMarker: true });
    if (!found.ok) {
      return {
        ok: false,
        dispatched: false,
        failureCode: found.failureCode,
        message: found.message,
      };
    }

    const target = this.page.locator('[data-op-story-share="1"]').first();
    try {
      const live = await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: (el.innerText || '').trim(),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
      const viewportHeight = await this.page.evaluate(() => window.innerHeight);
      const expected = STORY_UI.exactShareButtonText.toLowerCase();
      const stillExact =
        live.tag === 'BUTTON' &&
        live.text.toLowerCase() === expected &&
        !live.disabled &&
        live.rect.y > viewportHeight * 0.65 &&
        live.rect.width >= 40 &&
        live.rect.height >= 16;
      if (!stillExact) {
        return {
          ok: false,
          dispatched: false,
          failureCode: STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
          message: 'Share control no longer matches the verified Story editor control.',
          details: live,
        };
      }

      // Mark before dispatching: a thrown click must never be retried.
      this._shareDispatched = true;
      await target.click({ timeout: 5_000 });
      return {
        ok: true,
        dispatched: true,
        box: found.box,
        details: { ...found.details, live },
      };
    } catch (error) {
      return {
        ok: false,
        dispatched: this._shareDispatched ? 'unknown' : false,
        failureCode: STORY_FAILURE_CODES.SHARE_CLICK_AMBIGUOUS,
        message: `Share click failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      };
    } finally {
      await this._cleanupShareMarker();
    }
  }

  /** Remove the temporary Share marker; never throws. */
  async _cleanupShareMarker() {
    try {
      await this.page.evaluate(() =>
        document
          .querySelector('[data-op-story-share="1"]')
          ?.removeAttribute('data-op-story-share'),
      );
    } catch {
      // Navigation may have replaced the document.
    }
  }

  /**
   * @param {AbortSignal} [signal]
   */
  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error('Story editor verification aborted');
      error.name = 'AbortError';
      throw error;
    }
  }
}
