import { PublicationOutcome } from './publication-outcomes.js';

/**
 * Stable publication failure codes and recovery semantics.
 *
 * A failure classification never guesses that publication failed when a Share
 * may have reached Instagram. Pre-Share failures default to PUBLISH_FAILED;
 * any post-Share ambiguity defaults to PUBLICATION_UNCERTAIN.
 */
export const PublicationFailureCode = Object.freeze({
  MEDIA_MISSING: 'MEDIA_MISSING',
  MEDIA_INVALID: 'MEDIA_INVALID',
  ACCOUNT_INVALID: 'ACCOUNT_INVALID',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  CHECKPOINT_REQUIRED: 'CHECKPOINT_REQUIRED',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
  CDP_CONNECTION_FAILED: 'CDP_CONNECTION_FAILED',
  PAGE_CLOSED: 'PAGE_CLOSED',
  EDITOR_UNAVAILABLE: 'EDITOR_UNAVAILABLE',
  UPLOAD_TIMEOUT: 'UPLOAD_TIMEOUT',
  PREVIEW_MISMATCH: 'PREVIEW_MISMATCH',
  SHARE_DISABLED: 'SHARE_DISABLED',
  SHARE_AMBIGUOUS: 'SHARE_AMBIGUOUS',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  SHARE_INTENT_NOT_DISPATCHED: 'SHARE_INTENT_NOT_DISPATCHED',
  SHARE_DISPATCHED_NO_RESPONSE: 'SHARE_DISPATCHED_NO_RESPONSE',
  BROWSER_CRASH_AFTER_SHARE: 'BROWSER_CRASH_AFTER_SHARE',
  NETWORK_DISCONNECT_AFTER_SHARE: 'NETWORK_DISCONNECT_AFTER_SHARE',
  SUCCESS_TOAST_MISSING: 'SUCCESS_TOAST_MISSING',
  TOAST_VISIBLE_VIEWER_UNAVAILABLE: 'TOAST_VISIBLE_VIEWER_UNAVAILABLE',
  VIEWER_IMAGE_MISMATCH: 'VIEWER_IMAGE_MISMATCH',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  DUPLICATE_STORY: 'DUPLICATE_STORY',
  PLATFORM_ERROR_UNCERTAIN: 'PLATFORM_ERROR_UNCERTAIN',
  CANCELLED_BEFORE_SHARE: 'CANCELLED_BEFORE_SHARE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @typedef {{
 *   code: string,
 *   message: string,
 *   outcome: string,
 *   retryable: boolean,
 *   recoveryAction: string,
 *   shareMayHaveOccurred: boolean,
 *   manualIntervention: boolean,
 * }} PublicationFailure
 */

/** @type {Readonly<Record<string, Omit<PublicationFailure, 'code'>>>} */
const DEFINITIONS = Object.freeze({
  [PublicationFailureCode.MEDIA_MISSING]: {
    message: 'The media file is missing.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Restore the exact media file and create a new safe attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.MEDIA_INVALID]: {
    message: 'The media failed validation.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Replace the media with a valid asset.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.ACCOUNT_INVALID]: {
    message: 'The authenticated account is not the expected account.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Re-authenticate the correct account before retrying.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.AUTHENTICATION_REQUIRED]: {
    message: 'Instagram authentication is required.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Complete authentication manually, then create a new attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.CHECKPOINT_REQUIRED]: {
    message: 'Instagram requires a security challenge or checkpoint.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Complete the challenge manually. Never bypass it.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.BROWSER_LAUNCH_FAILED]: {
    message: 'The browser could not be launched.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Verify the browser executable and retry a safe pre-Share attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.CDP_CONNECTION_FAILED]: {
    message: 'The CDP connection failed.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Reconnect the browser session, then retry a safe pre-Share attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.PAGE_CLOSED]: {
    message: 'The Instagram page closed unexpectedly.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'If no Share was dispatched, reacquire the page and retry safely.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.EDITOR_UNAVAILABLE]: {
    message: 'The Story editor was unavailable.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Inspect diagnostics and retry a safe pre-Share attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.UPLOAD_TIMEOUT]: {
    message: 'The media upload timed out.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Inspect the editor state before creating a new attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.PREVIEW_MISMATCH]: {
    message: 'The preview image did not match the source media.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Do not publish. Inspect the upload and media pipeline.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.SHARE_DISABLED]: {
    message: 'The Share control was disabled.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: true,
    recoveryAction: 'Wait for the editor to finish preparing, then retry a safe pre-Share attempt.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.SHARE_AMBIGUOUS]: {
    message: 'The Share control was ambiguous or changed.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Do not force-click. Inspect diagnostics and the current UI state.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.AUTHORIZATION_FAILED]: {
    message: 'Publication authorization was missing or invalid.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Do not publish. Obtain a new explicit per-attempt authorization.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.SHARE_INTENT_NOT_DISPATCHED]: {
    message: 'The Share intent was persisted, but no click was dispatched.',
    outcome: PublicationOutcome.PUBLISH_FAILED,
    retryable: false,
    recoveryAction: 'Inspect the operation. Do not automatically retry an operation with a Share intent.',
    shareMayHaveOccurred: false,
    manualIntervention: true,
  },
  [PublicationFailureCode.SHARE_DISPATCHED_NO_RESPONSE]: {
    message: 'The Share click was dispatched, but no result was observed.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Verify the account Story state read-only. Never automatically retry.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.BROWSER_CRASH_AFTER_SHARE]: {
    message: 'The browser crashed after the Share click may have occurred.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Inspect the account Story state read-only. Never automatically retry.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.NETWORK_DISCONNECT_AFTER_SHARE]: {
    message: 'The network disconnected after the Share click may have occurred.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Verify the account Story state read-only. Never automatically retry.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.SUCCESS_TOAST_MISSING]: {
    message: 'The success toast was not observed.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Verify the account Story viewer read-only.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.TOAST_VISIBLE_VIEWER_UNAVAILABLE]: {
    message: 'The success toast was visible, but the Story viewer was unavailable.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Retry read-only verification later. Do not republish.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.VIEWER_IMAGE_MISMATCH]: {
    message: 'The Story viewer image did not match the source media.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Do not mark published. Inspect the account and diagnostics.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.ACCOUNT_MISMATCH]: {
    message: 'The Story appeared on a different account.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Stop. Inspect account/session isolation before any further action.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.DUPLICATE_STORY]: {
    message: 'A Story for this operation may already exist.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Inspect the account. Never create a duplicate Story.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.PLATFORM_ERROR_UNCERTAIN]: {
    message: 'Instagram returned an unclear error after the Share action.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Verify the account Story state read-only. Never automatically retry.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
  [PublicationFailureCode.CANCELLED_BEFORE_SHARE]: {
    message: 'The operation was cancelled before Share.',
    outcome: PublicationOutcome.CANCELLED,
    retryable: false,
    recoveryAction: 'Create a new explicitly authorized attempt if needed.',
    shareMayHaveOccurred: false,
    manualIntervention: false,
  },
  [PublicationFailureCode.UNKNOWN]: {
    message: 'An unknown publication failure occurred.',
    outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
    retryable: false,
    recoveryAction: 'Inspect the durable operation and account state. Do not retry blindly.',
    shareMayHaveOccurred: true,
    manualIntervention: true,
  },
});

/**
 * @param {string} code
 * @param {Partial<PublicationFailure>} [overrides]
 * @returns {PublicationFailure}
 */
export function classifyPublicationFailure(code, overrides = {}) {
  const normalizedCode = String(code ?? PublicationFailureCode.UNKNOWN);
  const definition = DEFINITIONS[normalizedCode] ?? DEFINITIONS[PublicationFailureCode.UNKNOWN];
  return {
    code: normalizedCode,
    message: overrides.message ?? definition.message,
    outcome: overrides.outcome ?? definition.outcome,
    retryable: overrides.retryable ?? definition.retryable,
    recoveryAction: overrides.recoveryAction ?? definition.recoveryAction,
    shareMayHaveOccurred:
      overrides.shareMayHaveOccurred ?? definition.shareMayHaveOccurred,
    manualIntervention:
      overrides.manualIntervention ?? definition.manualIntervention,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function failureCodeFromError(error) {
  const explicit = error?.code ?? error?.failureCode;
  if (typeof explicit === 'string' && DEFINITIONS[explicit]) return explicit;
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (message.includes('captcha') || message.includes('checkpoint')) {
    return PublicationFailureCode.CHECKPOINT_REQUIRED;
  }
  if (message.includes('auth') || message.includes('login')) {
    return PublicationFailureCode.AUTHENTICATION_REQUIRED;
  }
  if (message.includes('cdp')) return PublicationFailureCode.CDP_CONNECTION_FAILED;
  if (message.includes('page') && message.includes('closed')) {
    return PublicationFailureCode.PAGE_CLOSED;
  }
  if (message.includes('browser')) return PublicationFailureCode.BROWSER_LAUNCH_FAILED;
  if (message.includes('share')) return PublicationFailureCode.SHARE_DISPATCHED_NO_RESPONSE;
  return PublicationFailureCode.UNKNOWN;
}

export const PUBLICATION_FAILURE_DEFINITIONS = DEFINITIONS;
