/**
 * Future Instagram feature modules must implement the shared task-handler
 * interface and must NOT manage browser, database, or process lifecycle.
 *
 * Supported future module domains (authorized / permissioned use only):
 * - content management
 * - publishing
 * - comment moderation
 * - messaging
 * - account insights
 * - notifications
 * - reports
 *
 * Explicitly out of scope for this project:
 * - mass following / liking / unfollowing
 * - unsolicited bulk messaging
 * - scraping other users' personal data
 * - CAPTCHA bypass / anti-detection / rate-limit evasion
 *
 * Prefer official Instagram Platform APIs for business/creator capabilities.
 *
 * Example handler shape:
 *
 * {
 *   type: 'content.publish',
 *   description: 'Publish an authorized piece of content',
 *   requiresAuth: true,
 *   externalSideEffect: true,
 *   execute: async (context, payload, signal) => {
 *     context.markSideEffect(true);
 *     // Use context.instagram / context.browser; never open SQLite or Chrome yourself.
 *     return { ok: true };
 *   },
 * }
 */

export const FUTURE_MODULE_DOMAINS = Object.freeze([
  'content',
  'publishing',
  'comment-moderation',
  'messaging',
  'insights',
  'notifications',
  'reports',
  'intelligence',
]);

/**
 * Phase 3.1 content management is implemented under `src/modules/content/`.
 * Publishing uses the Phase 2 task type `content.publish`.
 * Authorized own-account browser UI automation (Playwright Story publishing)
 * is allowed. Do not scrape other users' data or call undocumented private APIs.
 */

/**
 * @typedef {import('../tasks/types.js').TaskHandler} FutureModuleHandler
 */

export {};
