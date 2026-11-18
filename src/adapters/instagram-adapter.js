import { AuthState, detectAuthState } from '../auth/auth-state.js';

/**
 * Instagram-facing adapter for authorized feature modules.
 * Auth-state checks live here; Story mutations go through the Playwright
 * publishing adapter (context.browser), not this class.
 */
export class InstagramAdapter {
  /**
   * @param {{
   *   browser: import('./browser-adapter.js').BrowserAdapter,
   *   baseUrl?: string,
   *   detectAuthStateFn?: typeof detectAuthState,
   * }} options
   */
  constructor(options) {
    this.browser = options.browser;
    this.baseUrl = options.baseUrl ?? 'https://www.instagram.com';
    this._detectAuthState = options.detectAuthStateFn ?? detectAuthState;
  }

  /**
   * @returns {Promise<import('../auth/auth-state.js').AuthStateResult>}
   */
  async getAuthState() {
    const page = this.browser.getPage();
    return this._detectAuthState(page);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async isAuthenticated() {
    const result = await this.getAuthState();
    return result.state === AuthState.AUTHENTICATED;
  }
}

export { AuthState };
