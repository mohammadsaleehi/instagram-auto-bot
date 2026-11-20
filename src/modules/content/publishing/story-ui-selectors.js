/**
 * Verified mobile-web Story UI facts (390×844 portrait, 2026-11-19).
 *
 * QUARANTINED CATALOG: the desktop Story route is removed. Live Story code
 * lives in `story/` and imports only the verified constants below. Do not add
 * desktop/Story-tray/profile-avatar entry points. Do not use a loose regex to
 * decide that a control is Share: the only valid control is an enabled native
 * button whose own trimmed text is exactly "Add to your story".
 *
 * Live UI facts (mobile web 390×844, 2026-11-19):
 * - Header create control sits immediately LEFT of Notifications (heart).
 * - That control is an <a href="#"> whose SVG path is a plus (`M21 11h-8V3…`)
 *   but Instagram currently mislabels it `aria-label="Home"` / <title>Home</title>.
 * - `svg[aria-label="Plus icon"]` is the Stories-tray avatar badge — FORBIDDEN.
 * - Creation menu shows Post + Story as role=button rows (often inside role=dialog).
 *   It does NOT use role="menu".
 * - Clicking Story fires a native Playwright `filechooser` (Story upload control).
 *   The in-page menu may remain visible until files are chosen — that is expected.
 * - Hidden display:none feed file inputs must NEVER count as Story composer ready.
 *
 * Forbidden entry points:
 * - "Your story" tray / avatar plus badge
 * - Other users' Story avatars
 * - Direct `/create/story/` navigation
 * - Treating header "+" alone as Story (Story menu click is mandatory)
 * - Feed scrolling while hunting for controls
 */
export const STORY_UI = Object.freeze({
  /** Descriptor used for UA / touch; viewport overridden to full portrait screen. */
  mobileDeviceName: 'iPhone 13',

  /**
   * Full portrait metrics Instagram accepts for Story share.
   * Do NOT use Playwright's chrome-shrunk iPhone 13 viewport (390×664).
   */
  portraitViewport: Object.freeze({ width: 390, height: 844 }),
  portraitScreen: Object.freeze({ width: 390, height: 844 }),
  portraitDeviceScaleFactor: 3,

  /** Top-bar Notifications / heart — header create sits immediately to its left. */
  headerNotificationsAria: Object.freeze([
    'Notifications',
    'Activity Feed',
    'Activity',
  ]),

  /** Max Y (CSS px) for top-header chrome. */
  headerMaxTopPx: 60,

  /**
   * SVG path prefix of the header create (+) icon.
   * Live: mislabeled aria-label="Home" but path is a plus, not a house.
   */
  headerCreatePlusPathPrefix: 'M21 11h-8V3',

  /** Real bottom-nav Home house path starts differently — never treat as create. */
  headerHomeHousePathPrefix: 'm21.762',

  dismissDialogNames: Object.freeze([
    /^not\s*now$/i,
    /^close$/i,
    /^ok$/i,
    /^cancel$/i,
    /^dismiss$/i,
    /^skip$/i,
  ]),

  dismissDialogAria: Object.freeze(['Close', 'Dismiss']),

  /** Creation menu options after header create click (role=button text). */
  createMenuPostNames: Object.freeze([/^post$/i]),
  createMenuStoryNames: Object.freeze([/^story$/i]),

  createMenuPostAria: Object.freeze(['Post']),
  createMenuStoryAria: Object.freeze(['Story']),

  /** Menu options must appear in this Y band (below header, above feed). */
  createMenuMaxTopPx: 180,
  createMenuMinTopPx: 20,

  /** Post composer markers — never accept as Story entry. */
  postComposerText: Object.freeze([
    /create\s+new\s+post/i,
    /drag\s+photos\s+and\s+videos\s+here/i,
  ]),

  selectFromComputerNames: Object.freeze([
    /select\s+from\s+computer/i,
    /select\s+from\s+gallery/i,
  ]),

  fileInput: Object.freeze([
    'input[type="file"][accept*="image/jpeg"]',
    'input[type="file"][accept*="image/png"]',
    'input[type="file"][accept*="image/avif"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="video"]',
    'form input[type="file"]',
    'input[type="file"]',
  ]),

  nextNames: Object.freeze([/^next$/i, /^continue$/i, /^ok$/i, /^done$/i]),

  /**
   * The only readiness label. Matching is exact on the element's own trimmed
   * text; a paragraph such as "Rotate your device to add to your story" must
   * never qualify.
   */
  exactShareButtonText: 'Add to your story',

  shareAriaLabels: Object.freeze(['Add to your story']),

  rotateDeviceText: Object.freeze([
    /rotate\s+your\s+device/i,
    /rotate\s+your\s+phone/i,
    /turn\s+your\s+device/i,
  ]),

  successText: Object.freeze([
    /your\s+story\s+(was\s+)?shared/i,
    /story\s+was\s+added/i,
    /shared\s+to\s+your\s+story/i,
    /added\s+to\s+your\s+story/i,
  ]),

  authenticatedChrome: Object.freeze([
    'svg[aria-label="Home"]',
    'svg[aria-label="Search"]',
    'svg[aria-label="Explore"]',
    'svg[aria-label="Reels"]',
    'svg[aria-label="Messages"]',
    'svg[aria-label="Notifications"]',
    'svg[aria-label="Post"]',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'a[href="/"]',
  ]),

  humanRequired: Object.freeze([
    /confirm\s+it.?s\s+you/i,
    /suspicious/i,
    /try\s+again\s+later/i,
    /checkpoint/i,
    /verify\s+your\s+identity/i,
  ]),

  humanRequiredCss: Object.freeze([
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
  ]),

  /** Explicit Story-entry failure codes. */
  failureCodes: Object.freeze({
    HEADER_CREATE_BUTTON_NOT_FOUND: 'HEADER_CREATE_BUTTON_NOT_FOUND',
    STORY_OPTION_NOT_AVAILABLE: 'STORY_OPTION_NOT_AVAILABLE',
    STORY_COMPOSER_NOT_OPENED: 'STORY_COMPOSER_NOT_OPENED',
    STORY_UI_ENTRY_NOT_FOUND: 'STORY_UI_ENTRY_NOT_FOUND',
  }),
});
