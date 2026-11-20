import { ContentError } from '../../constants.js';
import { STORY_FAILURE_CODES, STORY_STATE_TIMEOUTS, StoryPublishState } from './story-states.js';

/**
 * Uploads exactly one local media file through the native Story file chooser
 * (or, only as a fallback, a usable in-page Story file input).
 *
 * `setFiles()` resolving is not treated as proof of upload. The editor module
 * must still verify the Story URL, preview canvas, and image identity.
 */
export class StoryUpload {
  /**
   * @param {{
   *   page: import('playwright').Page,
   *   session: import('./story-browser-session.js').StoryBrowserSession,
   *   timeouts?: { stepPollMs?: number },
   *   logger?: { info?: Function, warn?: Function } | null,
   * }} options
   */
  constructor(options) {
    this.page = options.page;
    this.session = options.session;
    this.stepPollMs = options.timeouts?.stepPollMs ?? 400;
    this.logger = options.logger ?? null;
  }

  /**
   * Reject feed-level hidden inputs and while the creation menu is still open.
   * @returns {Promise<import('playwright').ElementHandle|null>}
   */
  async findUsableFileInput() {
    const menuStoryVisible = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="button"], button, [role="menuitem"]')).some(
        (el) => {
          const r = el.getBoundingClientRect();
          const text = (el.innerText || '').trim();
          return r.y >= 20 && r.y <= 180 && /^story$/i.test(text);
        },
      ),
    );
    if (menuStoryVisible) return null;

    const handle = await this.page.evaluateHandle(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      for (const input of inputs) {
        const accept = input.getAttribute('accept') || '';
        if (accept && !/image|video/i.test(accept)) continue;
        const style = getComputedStyle(input);
        const inDialog = Boolean(input.closest('[role="dialog"]'));
        if (style.display === 'none' && !inDialog) continue;
        return input;
      }
      return null;
    });
    return handle.asElement();
  }

  /**
   * @param {{
   *   chooser?: import('playwright').FileChooser|null,
   *   filePath: string,
   *   fileName: string,
   *   signal?: AbortSignal,
   * }} input
   * @returns {Promise<{
   *   ok: boolean,
   *   failureCode: string|null,
   *   message?: string,
   *   via?: 'filechooser'|'file-input',
   *   url?: string,
   *   setFilesAt?: string,
   * }>}
   */
  async upload(input) {
    this._throwIfAborted(input.signal);
    const startedAt = new Date().toISOString();
    let via = 'filechooser';

    try {
      if (input.chooser) {
        await input.chooser.setFiles(input.filePath);
      } else {
        const handle = await this.findUsableFileInput();
        if (!handle) {
          return {
            ok: false,
            failureCode: STORY_FAILURE_CODES.FILE_INPUT_MISSING,
            message: 'No native file chooser and no usable Story file input was available.',
          };
        }
        via = 'file-input';
        await handle.setInputFiles(input.filePath);
      }
    } catch (error) {
      return {
        ok: false,
        failureCode: STORY_FAILURE_CODES.FILE_INPUT_REJECTED,
        message: `Instagram did not accept the selected file: ${error instanceof Error ? error.message : String(error)}`,
        via,
        setFilesAt: startedAt,
      };
    }

    const setFilesAt = new Date().toISOString();
    this.logger?.info?.('Story file selected', {
      fileName: input.fileName,
      via,
      setFilesAt,
    });

    const deadline =
      Date.now() + STORY_STATE_TIMEOUTS[StoryPublishState.EDITOR_LOADING];
    let url = this.page.url();
    while (Date.now() < deadline) {
      this._throwIfAborted(input.signal);
      url = this.page.url();
      if (/\/create\/story\/?/i.test(url)) {
        // Let the editor render its first frame before verification.
        await this.page.waitForTimeout(300);
        return { ok: true, failureCode: null, via, url, setFilesAt };
      }
      const errorText = await this._readUploadError();
      if (errorText) {
        return {
          ok: false,
          failureCode: STORY_FAILURE_CODES.FILE_INPUT_REJECTED,
          message: `Instagram reported an upload error: ${errorText}`,
          via,
          url,
          setFilesAt,
        };
      }
      await this.page.waitForTimeout(this.stepPollMs);
    }

    return {
      ok: false,
      failureCode: STORY_FAILURE_CODES.EDITOR_NOT_OPENED,
      message: 'The Story editor URL did not appear after selecting the file.',
      via,
      url,
      setFilesAt,
    };
  }

  /** @returns {Promise<string|null>} */
  async _readUploadError() {
    try {
      return await this.page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 4000);
        const match = text.match(/(couldn'?t upload[^\n]*|upload failed[^\n]*|something went wrong[^\n]*)/i);
        return match ? match[0].slice(0, 160) : null;
      });
    } catch {
      return null;
    }
  }

  /**
   * @param {AbortSignal} [signal]
   */
  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error('Story upload aborted');
      error.name = 'AbortError';
      throw error;
    }
  }
}

export { ContentError };
