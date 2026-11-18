import { classifyError } from '../execution/retry-manager.js';
import { ConfigError } from '../config/config.js';
import { BrowserError } from '../browser/browser-manager.js';
import { LoginError } from '../auth/instagram-login.js';
import { StorageStateError } from '../auth/storage-state.js';
import { DatabaseError } from '../storage/database.js';
import { ShutdownError } from '../utils/shutdown.js';
import { TaskError } from '../tasks/constants.js';

/**
 * Normalize errors for logging without leaking secrets.
 *
 * @param {unknown} error
 * @returns {{
 *   name: string,
 *   message: string,
 *   code: string | null,
 *   errorClass: string,
 *   retryable: boolean,
 * }}
 */
export function sanitizeError(error) {
  const classified = classifyError(error);
  const name = error instanceof Error ? error.name : 'Error';
  return {
    name,
    message: classified.message,
    code: classified.code,
    errorClass: classified.errorClass,
    retryable: classified.retryable,
  };
}

/**
 * Map known error types to process exit codes.
 *
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeForError(error) {
  if (error instanceof ShutdownError) {
    return 130;
  }
  if (
    error instanceof ConfigError ||
    error instanceof BrowserError ||
    error instanceof LoginError ||
    error instanceof StorageStateError ||
    error instanceof DatabaseError ||
    error instanceof TaskError
  ) {
    return 1;
  }
  return 1;
}
