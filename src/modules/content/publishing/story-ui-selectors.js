/**
 * Locators for Instagram web Story creation.
 * Prefer role / accessible name / text; keep CSS as last-resort fallbacks.
 * Instagram changes markup often — treat misses as recoverable UI failures.
 */
export const STORY_UI = Object.freeze({
  /** Create / New post entry points on the home chrome. */
  createEntry: Object.freeze([
    'role=link[name=/new post/i]',
    'role=button[name=/new post/i]',
    'role=link[name=/create/i]',
    'role=button[name=/create/i]',
    'a[href="/create/style/"]',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
  ]),

  /** Switch composer to Story mode when a post dialog opened first. */
  storyMode: Object.freeze([
    'role=button[name=/^story$/i]',
    'role=tab[name=/story/i]',
    'role=link[name=/story/i]',
    'text=/^Story$/i',
  ]),

  /** File inputs used by the create dialog. */
  fileInput: Object.freeze([
    'input[type="file"][accept*="image"]',
    'form input[type="file"]',
    'input[type="file"]',
  ]),

  /** Alternate entry that opens the file picker. */
  selectFromComputer: Object.freeze([
    'role=button[name=/select from computer/i]',
    'text=/Select from computer/i',
  ]),

  /** Preview / canvas signals that an image was accepted. */
  previewReady: Object.freeze([
    'role=button[name=/add to your story/i]',
    'role=button[name=/share to story/i]',
    'role=button[name=/^share$/i]',
    'canvas',
    'img[alt*="preview" i]',
  ]),

  /** Final share / publish actions for Stories. */
  share: Object.freeze([
    'role=button[name=/add to your story/i]',
    'role=button[name=/share to story/i]',
    'role=button[name=/share$/i]',
    'div[role="button"]:has-text("Share")',
  ]),

  /** Soft success signals after sharing (never sole proof alone). */
  success: Object.freeze([
    'text=/your story was shared/i',
    'text=/story was added/i',
    'text=/shared to your story/i',
  ]),

  /** Blocking security / challenge UI. */
  humanRequired: Object.freeze([
    'text=/confirm it.?s you/i',
    'text=/suspicious/i',
    'text=/try again later/i',
    'text=/checkpoint/i',
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
  ]),
});
