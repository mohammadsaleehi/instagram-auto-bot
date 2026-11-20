import { ContentError } from '../../constants.js';
import { STORY_UI } from '../story-ui-selectors.js';
import {
  STORY_FAILURE_CODES,
  STORY_STATE_TIMEOUTS,
  StoryPublishState,
} from './story-states.js';

const HEADER_MAX_TOP_PX = STORY_UI.headerMaxTopPx;
const MENU_MIN_TOP_PX = STORY_UI.createMenuMinTopPx;
const MENU_MAX_TOP_PX = STORY_UI.createMenuMaxTopPx;
const NOTIFICATION_LABELS = STORY_UI.headerNotificationsAria;
const PLUS_PATH_PREFIX = STORY_UI.headerCreatePlusPathPrefix;

/**
 * Verified Instagram Story entry:
 *   top-header Create (+) immediately left of Notifications
 *   -> Post/Story menu -> Story -> native filechooser.
 *
 * This module never uses profile avatars, the Story tray, "Your story",
 * direct `/create/story/` URLs, `page.setViewportSize()`, `page.screenshot()`,
 * `force: true`, or JS `.click()`.
 */
export class StoryEntry {
  /**
   * @param {{
   *   page: import('playwright').Page,
   *   session: import('./story-browser-session.js').StoryBrowserSession,
   *   timeouts?: { stepPollMs?: number, fileChooserMs?: number },
   *   logger?: { info?: Function, warn?: Function } | null,
   * }} options
   */
  constructor(options) {
    this.page = options.page;
    this.session = options.session;
    this.stepPollMs = options.timeouts?.stepPollMs ?? 400;
    this.fileChooserTimeoutMs =
      options.timeouts?.fileChooserMs ??
      STORY_STATE_TIMEOUTS[StoryPublishState.STORY_OPTION_CLICKED];
    this.logger = options.logger ?? null;
  }

  /**
   * @returns {Promise<{ok: boolean, reason: string, selected?: Record<string, unknown>}>}
   */
  async resolveHeaderCreatePlus() {
    return this.page.evaluate(
      ({ maxTop, labels, plusPrefix, menuMin, menuMax }) => {
        let notifications = null;
        for (const label of labels) {
          const el = document.querySelector(`svg[aria-label="${label}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.top < maxTop && r.width > 0) {
            notifications = el;
            break;
          }
        }
        if (!notifications) {
          return { ok: false, reason: 'notifications-not-in-header' };
        }
        const nr = notifications.getBoundingClientRect();
        const candidates = Array.from(
          document.querySelectorAll('a[href="#"], a[role="link"], button, [role="button"]'),
        );
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.top >= maxTop || r.width < 16 || r.height < 16) continue;
          if (r.left >= nr.left || r.right > nr.left + 8) continue;
          const svg = el.querySelector('svg');
          const d = svg?.querySelector('path')?.getAttribute('d') || '';
          if (!d.startsWith(plusPrefix)) continue;
          const aria = svg?.getAttribute('aria-label') || el.getAttribute('aria-label') || null;
          if (aria === 'Plus icon') continue;
          const menuBandValid =
            r.top >= menuMin - 60 && r.top + r.height <= menuMax + 80;
          return {
            ok: true,
            reason: 'verified-header-create-plus-path',
            selected: {
              tag: el.tagName,
              role: el.getAttribute('role'),
              href: el.getAttribute('href'),
              aria,
              title: svg?.querySelector('title')?.textContent || null,
              pathPrefix: plusPrefix,
              menuBandValid,
              box: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
              },
              notificationsBox: {
                x: Math.round(nr.x),
                y: Math.round(nr.y),
                width: Math.round(nr.width),
                height: Math.round(nr.height),
              },
            },
          };
        }
        return { ok: false, reason: 'header-create-plus-not-left-of-notifications' };
      },
      {
        maxTop: HEADER_MAX_TOP_PX,
        labels: NOTIFICATION_LABELS,
        plusPrefix: PLUS_PATH_PREFIX,
        menuMin: MENU_MIN_TOP_PX,
        menuMax: MENU_MAX_TOP_PX,
      },
    );
  }

  /**
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async listCreateMenuOptions() {
    return this.page.evaluate(
      ({ minTop, maxTop }) =>
        Array.from(document.querySelectorAll('[role="button"], button, [role="menuitem"]'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            const text = (el.innerText || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            let kind = null;
            if (/^post$/i.test(text) || /^post$/i.test(aria)) kind = 'post';
            if (/^story$/i.test(text) || /^story$/i.test(aria)) kind = 'story';
            if (!kind) return null;
            if (r.y < minTop || r.y > maxTop || r.width < 8 || r.height < 8) return null;
            return {
              kind,
              text,
              aria: aria || null,
              role: el.getAttribute('role'),
              y: Math.round(r.y),
              x: Math.round(r.x),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          })
          .filter(Boolean),
      { minTop: MENU_MIN_TOP_PX, maxTop: MENU_MAX_TOP_PX },
    );
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<{ok: boolean, hasPost: boolean, hasStory: boolean, options: Array<Record<string, unknown>>}>}
   */
  async waitForCreateMenu(timeoutMs = STORY_STATE_TIMEOUTS[StoryPublishState.CREATE_MENU_OPEN]) {
    const deadline = Date.now() + timeoutMs;
    let options = [];
    while (Date.now() < deadline) {
      options = await this.listCreateMenuOptions();
      const hasPost = options.some((option) => option.kind === 'post');
      const hasStory = options.some((option) => option.kind === 'story');
      if (hasPost && hasStory) {
        return { ok: true, hasPost, hasStory, options };
      }
      await this.page.waitForTimeout(this.stepPollMs);
    }
    return {
      ok: false,
      hasPost: options.some((option) => option.kind === 'post'),
      hasStory: options.some((option) => option.kind === 'story'),
      options,
    };
  }

  /**
   * @returns {import('playwright').Locator}
   */
  _headerPlusLocator() {
    return this.page
      .locator(`a[href="#"]:has(svg path[d^="${PLUS_PATH_PREFIX}"]), [role="button"]:has(svg path[d^="${PLUS_PATH_PREFIX}"])`)
      .first();
  }

  /**
   * @param {string} timeoutMs
   * @returns {Promise<{ok: boolean, reason: string, selected?: Record<string, unknown>, menu?: Record<string, unknown>}>}
   */
  async openCreateMenu(timeoutMs = STORY_STATE_TIMEOUTS[StoryPublishState.CREATE_MENU_OPEN]) {
    const resolved = await this.resolveHeaderCreatePlus();
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }
    const locator = this._headerPlusLocator();
    if ((await locator.count()) !== 1) {
      return { ok: false, reason: 'header-create-plus-locator-not-unique' };
    }
    const box = await locator.boundingBox();
    if (!box) {
      return { ok: false, reason: 'header-create-plus-has-no-box' };
    }

    // Normal click only. Instagram can show delayed onboarding modals after
    // the pre-entry dismissal; each intercept gets another dismissal pass,
    // never a force-click. No Share is involved here.
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await locator.click({ timeout: 5_000 });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await this.session.dismissBlockingDialogs();
          await this.page.waitForTimeout(300);
        }
      }
    }
    if (lastError) {
      return {
        ok: false,
        reason: `header-create-click-intercepted:${lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError)}`,
        selected: resolved.selected,
      };
    }

    await this.page.waitForTimeout(500);
    const menu = await this.waitForCreateMenu(timeoutMs);
    if (!menu.ok) {
      return {
        ok: false,
        reason: menu.hasPost ? 'create-menu-story-missing' : 'create-menu-not-opened',
        selected: resolved.selected,
        menu,
      };
    }
    return { ok: true, reason: 'create-menu-verified', selected: resolved.selected, menu };
  }

  /**
   * Locate the exact Story option inside the creation dialog and validate it.
   *
   * @returns {Promise<{ok: boolean, failureCode: string|null, locator?: import('playwright').Locator, box?: Record<string, number>, dialogStoryCount?: number, dialogPostCount?: number, reason?: string}>}
   */
  async resolveStoryOption() {
    const dialog = this.page.locator('[role="dialog"]').first();
    const dialogCount = await dialog.count();
    if (dialogCount < 1) {
      return { ok: false, failureCode: STORY_FAILURE_CODES.CREATE_MENU_STORY_MISSING, reason: 'creation-dialog-missing' };
    }

    // Live accessibility names include the trailing icon text (e.g.
    // "Story New story"), so exact role-name matching is not reliable. Use
    // the row's own trimmed text, then mark the single verified element and
    // click it through Playwright (never JS `.click()`).
    const options = await dialog.evaluate((dlg) => {
      const rows = Array.from(dlg.querySelectorAll('[role="button"], button'));
      const read = (el) => (el.innerText || '').trim();
      const stories = rows.filter((el) => read(el).toLowerCase() === 'story');
      const posts = rows.filter((el) => read(el).toLowerCase() === 'post');
      if (stories.length === 1) {
        stories[0].setAttribute('data-op-story-option', '1');
      }
      return {
        rowTexts: rows.map(read).slice(0, 20),
        storyCount: stories.length,
        postCount: posts.length,
      };
    });

    if (options.storyCount === 0) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.CREATE_MENU_STORY_MISSING,
        reason: 'story-option-missing',
        dialogStoryCount: 0,
        dialogPostCount: options.postCount,
        rowTexts: options.rowTexts,
      };
    }
    if (options.storyCount > 1) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.STORY_OPTION_AMBIGUOUS,
        reason: `story-option-count:${options.storyCount}`,
        dialogStoryCount: options.storyCount,
        dialogPostCount: options.postCount,
        rowTexts: options.rowTexts,
      };
    }
    if (options.postCount < 1) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.CREATE_MENU_STORY_MISSING,
        reason: 'post-sibling-missing',
        dialogStoryCount: options.storyCount,
        dialogPostCount: 0,
        rowTexts: options.rowTexts,
      };
    }

    const locator = this.page.locator('[data-op-story-option="1"]').first();
    if ((await locator.count()) !== 1) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.STORY_OPTION_AMBIGUOUS,
        reason: 'annotated-story-option-not-unique',
        dialogStoryCount: options.storyCount,
        dialogPostCount: options.postCount,
      };
    }

    const box = await locator.boundingBox();
    if (!box) {
      return { ok: false, failureCode: STORY_FAILURE_CODES.STORY_OPTION_OUTSIDE_MENU, reason: 'story-option-no-box' };
    }
    if (box.y < MENU_MIN_TOP_PX || box.y > MENU_MAX_TOP_PX) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.STORY_OPTION_OUTSIDE_MENU,
        reason: `story-option-y:${Math.round(box.y)}`,
      };
    }

    return {
      ok: true,
      failureCode: null,
      locator,
      box: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      dialogStoryCount: options.storyCount,
      dialogPostCount: options.postCount,
    };
  }

  /**
   * @param {import('playwright').Locator} locator
   * @param {number} timeoutMs
   * @returns {Promise<{ok: boolean, chooser?: import('playwright').FileChooser, failureCode?: string, reason?: string}>}
   */
  async clickStoryAndAwaitChooser(locator, timeoutMs = STORY_STATE_TIMEOUTS[StoryPublishState.STORY_OPTION_CLICKED]) {
    // Listener MUST be registered before the click.
    const chooserPromise = this.page
      .waitForEvent('filechooser', { timeout: timeoutMs })
      .then((chooser) => ({ ok: true, chooser }))
      .catch((error) => ({ ok: false, error }));

    try {
      await locator.click({ timeout: 5_000 });
    } catch (error) {
      await this._cleanupStoryMarker();
      // Do not force. Return a deterministic failure.
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.FILECHOOSER_NOT_OPENED,
        reason: `story-click-failed:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      };
    }
    await this._cleanupStoryMarker();

    const result = await chooserPromise;
    if (!result.ok) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.FILECHOOSER_NOT_OPENED,
        reason: 'filechooser-timeout',
      };
    }
    return { ok: true, chooser: result.chooser };
  }

  /**
   * Full entry sequence.
   *
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   failureCode: string|null,
   *   message?: string,
   *   plus?: Record<string, unknown>,
   *   menu?: Array<Record<string, unknown>>,
   *   storyOption?: Record<string, unknown>,
   *   chooser?: import('playwright').FileChooser,
   * }>}
   */
  async enter(options = {}) {
    this._throwIfAborted(options.signal);
    await this.session.dismissBlockingDialogs();
    await this.session.capture('entry-before', {});

    const menuResult = await this.openCreateMenu();
    if (!menuResult.ok) {
      const failureCode = menuResult.reason.startsWith('header-create')
        ? STORY_FAILURE_CODES.HEADER_PLUS_NOT_FOUND
        : menuResult.reason === 'create-menu-story-missing'
          ? STORY_FAILURE_CODES.CREATE_MENU_STORY_MISSING
          : STORY_FAILURE_CODES.CREATE_MENU_NOT_OPENED;
      await this.session.capture('entry-create-menu-failed', { menuResult });
      return {
        ok: false,
        failureCode,
        message: `Story entry failed: ${menuResult.reason}`,
        plus: menuResult.selected,
        menu: menuResult.menu?.options,
      };
    }
    await this.session.capture('entry-create-menu-open', {
      menu: menuResult.menu?.options,
      plus: menuResult.selected,
    });

    const story = await this.resolveStoryOption();
    if (!story.ok) {
      await this.session.capture('entry-story-option-failed', { story });
      return {
        ok: false,
        failureCode: story.failureCode,
        message: `Story option unavailable: ${story.reason}`,
        plus: menuResult.selected,
        menu: menuResult.menu?.options,
      };
    }
    await this.session.capture('entry-story-option', {
      box: story.box,
      dialogStoryCount: story.dialogStoryCount,
      dialogPostCount: story.dialogPostCount,
    });

    const clicked = await this.clickStoryAndAwaitChooser(
      story.locator,
      this.fileChooserTimeoutMs,
    );
    if (!clicked.ok) {
      await this.session.capture('entry-filechooser-failed', { reason: clicked.reason });
      return {
        ok: false,
        failureCode: clicked.failureCode,
        message: `Story click did not open a file chooser: ${clicked.reason}`,
        plus: menuResult.selected,
        menu: menuResult.menu?.options,
        storyOption: story.box,
      };
    }

    await this.session.capture('entry-filechooser-received', {
      multiple: clicked.chooser.isMultiple(),
    });

    return {
      ok: true,
      failureCode: null,
      plus: menuResult.selected,
      menu: menuResult.menu?.options,
      storyOption: story.box,
      chooser: clicked.chooser,
    };
  }

  /** Remove the temporary selection marker; never throws. */
  async _cleanupStoryMarker() {
    try {
      await this.page.evaluate(() =>
        document.querySelector('[data-op-story-option="1"]')?.removeAttribute('data-op-story-option'),
      );
    } catch {
      // Navigation may already have replaced the document.
    }
  }

  /**
   * @param {AbortSignal} [signal]
   */
  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error('Story entry aborted');
      error.name = 'AbortError';
      throw error;
    }
  }
}

export { HEADER_MAX_TOP_PX, PLUS_PATH_PREFIX };
