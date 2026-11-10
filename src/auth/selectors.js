/**
 * Centralized Instagram UI selectors.
 * Verified against the live login DOM (2026-11):
 * - Username: input[name="email"] (legacy: input[name="username"])
 * - Password: input[name="pass"] (legacy: input[name="password"])
 * - Submit: div[aria-label="Log In"] / role=button "Log in"
 *           (legacy: button[type="submit"])
 * - Form: form#login_form
 */
export const SELECTORS = Object.freeze({
  loginForm:
    'form#login_form, form#loginForm, form[id*="login"], input[name="email"], input[name="username"]',
  usernameInput:
    'input[name="email"], input[name="username"], input[autocomplete*="username"]',
  passwordInput:
    'input[name="pass"], input[name="password"], input[type="password"]',
  // Prefer the visible Log In control; keep a legacy submit fallback.
  submitButton:
    'div[aria-label="Log In"], div[role="button"][aria-label="Log In"], button[type="submit"]',
  submitButtonByRoleName: /^log\s*in$/i,
  // Authenticated chrome / navigation signals
  authenticatedNav: [
    'svg[aria-label="Home"]',
    'svg[aria-label="Search"]',
    'svg[aria-label="Explore"]',
    'svg[aria-label="Reels"]',
    'svg[aria-label="Messages"]',
    'svg[aria-label="New post"]',
    'a[href="/direct/inbox/"]',
    'a[href*="/accounts/edit/"]',
  ].join(', '),
  profileLink: 'a[href^="/"][href$="/"]:has(img[alt$="profile picture"])',
  // Error / challenge signals
  loginError:
    '#slfErrorAlert, [role="alert"], p[id*="error"], div[data-testid="login-error-message"], #login_error_box',
  challengeText:
    'text=/suspicious|confirm it.?s you|help us confirm|verify your identity|security code|enter the code|two.?factor|checkpoint|confirm your account|try again later|too many|rate limit/i',
});

/**
 * URL path fragments that commonly indicate verification / challenge flows.
 */
export const VERIFICATION_PATH_HINTS = Object.freeze([
  '/challenge/',
  '/accounts/login/two_factor',
  '/two_factor',
  '/auth_platform/codeentry',
  '/consent/',
  '/accounts/suspended',
  '/accounts/restricted',
  '/privacy/checks',
]);

/**
 * URL path fragments that commonly indicate a logged-out experience.
 */
export const LOGGED_OUT_PATH_HINTS = Object.freeze([
  '/accounts/login',
  '/accounts/emailsignup',
  '/accounts/password/reset',
]);
