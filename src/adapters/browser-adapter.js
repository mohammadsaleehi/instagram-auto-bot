/**
 * Thin adapter over BrowserManager so task handlers never own browser lifecycle.
 */
export class BrowserAdapter {
  /**
   * @param {{
   *   browserManager: import('../browser/browser-manager.js').BrowserManager,
   * }} options
   */
  constructor(options) {
    this.browserManager = options.browserManager;
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return this.browserManager.isRunning();
  }

  /**
   * @returns {boolean}
   */
  isExistingMode() {
    return this.browserManager.isExistingMode();
  }

  /**
   * @returns {import('playwright').Page}
   */
  getPage() {
    return this.browserManager.getPage();
  }

  /**
   * @returns {import('playwright').BrowserContext}
   */
  getContext() {
    return this.browserManager.getContext();
  }

  /**
   * @returns {import('playwright').Browser | null}
   */
  getBrowser() {
    return this.browserManager.getBrowser();
  }

  /**
   * @returns {{
   *   connected: boolean,
   *   mode: string,
   *   ownsProcess: boolean,
   * }}
   */
  getHealth() {
    return {
      connected: this.isConnected(),
      mode: this.browserManager.mode,
      ownsProcess: Boolean(this.browserManager._ownsBrowserProcess),
    };
  }
}
