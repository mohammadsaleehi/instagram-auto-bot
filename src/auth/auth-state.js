import {
  LOGGED_OUT_PATH_HINTS,
  SELECTORS,
  VERIFICATION_PATH_HINTS,
} from './selectors.js';

/**
 * Authentication states the bot can detect.
 */
export const AuthState = Object.freeze({
  AUTHENTICATED: 'AUTHENTICATED',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @typedef {{
 *   state: string,
 *   url: string,
 *   signals: string[],
 *   reason: string,
 * }} AuthStateResult
 */

/**
 * @param {string} url
 * @returns {URL | null}
 */
function safeParseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * @param {string} pathname
 * @param {readonly string[]} hints
 * @returns {boolean}
 */
function pathMatchesAny(pathname, hints) {
  const normalized = pathname.toLowerCase();
  return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

/**
 * Classify authentication state from discrete page signals.
 * Pure function — suitable for unit testing without a browser.
 *
 * @param {{
 *   url?: string,
 *   hasLoginForm?: boolean,
 *   hasAuthenticatedNav?: boolean,
 *   hasChallengeIndicators?: boolean,
 *   hasLoginError?: boolean,
 * }} signals
 * @returns {AuthStateResult}
 */
export function classifyAuthState(signals = {}) {
  const url = signals.url ?? '';
  const parsed = safeParseUrl(url);
  const pathname = parsed?.pathname ?? '';
  const detected = [];

  if (signals.hasLoginForm) {
    detected.push('login_form_visible');
  }
  if (signals.hasAuthenticatedNav) {
    detected.push('authenticated_nav_visible');
  }
  if (signals.hasChallengeIndicators) {
    detected.push('challenge_indicators_visible');
  }
  if (signals.hasLoginError) {
    detected.push('login_error_visible');
  }
  if (pathname && pathMatchesAny(pathname, VERIFICATION_PATH_HINTS)) {
    detected.push('verification_url');
  }
  if (pathname && pathMatchesAny(pathname, LOGGED_OUT_PATH_HINTS)) {
    detected.push('logged_out_url');
  }

  const onVerificationPath = pathMatchesAny(pathname, VERIFICATION_PATH_HINTS);
  const onLoggedOutPath = pathMatchesAny(pathname, LOGGED_OUT_PATH_HINTS);

  // Verification takes priority when Instagram is clearly in a challenge flow.
  if (signals.hasChallengeIndicators || onVerificationPath) {
    // Login form on a challenge page still means the user must act.
    if (!signals.hasAuthenticatedNav) {
      return {
        state: AuthState.VERIFICATION_REQUIRED,
        url,
        signals: detected,
        reason: 'Verification or challenge flow detected',
      };
    }
  }

  // Authenticated nav + login form is ambiguous — treat as unknown.
  if (signals.hasAuthenticatedNav && signals.hasLoginForm) {
    return {
      state: AuthState.UNKNOWN,
      url,
      signals: detected,
      reason: 'Conflicting authenticated and login signals',
    };
  }

  // Clear authenticated signals without a login form.
  if (signals.hasAuthenticatedNav && !onLoggedOutPath) {
    return {
      state: AuthState.AUTHENTICATED,
      url,
      signals: detected,
      reason: 'Authenticated navigation elements are present',
    };
  }

  // Login form present — user must authenticate.
  if (signals.hasLoginForm || onLoggedOutPath) {
    if (signals.hasLoginError) {
      return {
        state: AuthState.LOGIN_REQUIRED,
        url,
        signals: detected,
        reason: 'Login form is visible and a login error was shown',
      };
    }

    return {
      state: AuthState.LOGIN_REQUIRED,
      url,
      signals: detected,
      reason: signals.hasLoginForm
        ? 'Login form is visible'
        : 'Current URL indicates a logged-out page',
    };
  }

  // Homepage root with neither clear signal.
  if (parsed && (pathname === '/' || pathname === '')) {
    return {
      state: AuthState.NOT_AUTHENTICATED,
      url,
      signals: detected,
      reason: 'Instagram root loaded without authenticated or login signals',
    };
  }

  if (detected.length === 0) {
    return {
      state: AuthState.UNKNOWN,
      url,
      signals: detected,
      reason: 'No conclusive authentication signals detected',
    };
  }

  return {
    state: AuthState.NOT_AUTHENTICATED,
    url,
    signals: detected,
    reason: 'Page does not appear authenticated',
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<boolean>}
 */
async function isVisible(page, selector) {
  try {
    const locator = page.locator(selector).first();
    // Instagram's SPA chrome can take a moment to hydrate after navigation.
    return await locator.isVisible({ timeout: 3_000 });
  } catch {
    return false;
  }
}

/**
 * Collect live page signals and classify authentication state.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<AuthStateResult>}
 */
export async function detectAuthState(page) {
  const url = page.url();

  const [hasLoginForm, hasAuthenticatedNav, hasChallengeIndicators, hasLoginError] =
    await Promise.all([
      isVisible(page, SELECTORS.loginForm),
      isVisible(page, SELECTORS.authenticatedNav),
      isVisible(page, SELECTORS.challengeText),
      isVisible(page, SELECTORS.loginError),
    ]);

  return classifyAuthState({
    url,
    hasLoginForm,
    hasAuthenticatedNav,
    hasChallengeIndicators,
    hasLoginError,
  });
}
