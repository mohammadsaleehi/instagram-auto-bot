import { AuthState, detectAuthState } from './auth-state.js';
import { LoginError } from './instagram-login.js';
import { sessionInvalidationMessage } from './storage-state.js';

/**
 * Storage-state mode: open Instagram and require an already-authenticated snapshot.
 * Does not fall back to credential auto-login or CDP.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   baseUrl: string,
 *   navigationTimeoutMs: number,
 *   logger: { info: Function, warn: Function, error: Function },
 *   storageStatePath: string,
 *   detectAuthStateFn?: typeof detectAuthState,
 * }} options
 * @returns {Promise<import('./auth-state.js').AuthStateResult>}
 */
export async function ensureStorageStateAuthenticated(page, options) {
  const detectAuthStateFn = options.detectAuthStateFn ?? detectAuthState;

  try {
    await page.goto(options.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs,
    });
    options.logger.info('Instagram opened', { url: page.url() });
  } catch (error) {
    throw new LoginError('Failed to open Instagram. Check your network connection and try again.', {
      code: 'NAVIGATION_FAILED',
      cause: error,
    });
  }

  const auth = await detectAuthStateFn(page);
  options.logger.info('Authentication state detected', {
    state: auth.state,
    reason: auth.reason,
    signals: auth.signals,
    url: auth.url,
  });

  if (auth.state === AuthState.AUTHENTICATED) {
    options.logger.info('Storage-state session is authenticated');
    return auth;
  }

  throw new LoginError(
    [
      `Storage-state authentication failed (state=${auth.state}: ${auth.reason}).`,
      'The bot will not create a new unauthenticated session.',
      sessionInvalidationMessage(auth.state, options.storageStatePath),
    ].join(' '),
    { code: 'STORAGE_STATE_AUTH_INVALID' },
  );
}
