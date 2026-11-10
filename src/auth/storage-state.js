import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_AUTH_STORAGE_STATE_PATH = path.resolve(
  PROJECT_ROOT,
  './data/instagram-auth.json',
);

export class StorageStateError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'StorageStateError';
    this.code = options.code ?? 'STORAGE_STATE_ERROR';
  }
}

/**
 * @param {string | undefined} value
 * @param {string} [fallback=DEFAULT_AUTH_STORAGE_STATE_PATH]
 * @returns {string}
 */
export function resolveAuthStorageStatePath(
  value,
  fallback = DEFAULT_AUTH_STORAGE_STATE_PATH,
) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

/**
 * True when a cookie domain is Instagram or an Instagram subdomain.
 *
 * @param {unknown} cookie
 * @returns {boolean}
 */
export function isInstagramCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') {
    return false;
  }

  const domain = String(/** @type {{ domain?: unknown }} */ (cookie).domain ?? '').toLowerCase();
  return domain === 'instagram.com' || domain.endsWith('.instagram.com');
}

/**
 * True when an origin belongs to Instagram.
 *
 * @param {unknown} originEntry
 * @returns {boolean}
 */
export function isInstagramOrigin(originEntry) {
  if (!originEntry || typeof originEntry !== 'object') {
    return false;
  }

  const origin = String(/** @type {{ origin?: unknown }} */ (originEntry).origin ?? '').toLowerCase();
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return origin.includes('instagram.com');
  }
}

/**
 * Keep only Instagram cookies/origins from a Playwright storage-state snapshot.
 * Strips unrelated personal Chrome sessions (Google, GitHub, ChatGPT, etc.).
 *
 * @param {unknown} state
 * @returns {{
 *   cookies: object[],
 *   origins: object[],
 *   removedCookieCount: number,
 *   removedOriginCount: number,
 * }}
 */
export function filterInstagramStorageState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new StorageStateError(
      'Auth storage state is invalid: expected a JSON object.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  const cookies = Array.isArray(/** @type {{ cookies?: unknown }} */ (state).cookies)
    ? /** @type {object[]} */ (/** @type {{ cookies: unknown[] }} */ (state).cookies)
    : null;
  const origins = /** @type {{ origins?: unknown }} */ (state).origins;

  if (!cookies) {
    throw new StorageStateError(
      'Auth storage state is invalid: missing cookies array.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  if (origins !== undefined && !Array.isArray(origins)) {
    throw new StorageStateError(
      'Auth storage state is invalid: origins must be an array when present.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  const originList = Array.isArray(origins) ? origins : [];
  const filteredCookies = cookies.filter(isInstagramCookie);
  const filteredOrigins = originList.filter(isInstagramOrigin);

  return {
    cookies: filteredCookies,
    origins: filteredOrigins,
    removedCookieCount: cookies.length - filteredCookies.length,
    removedOriginCount: originList.length - filteredOrigins.length,
  };
}

/**
 * Validate a Playwright storage-state object without logging secrets.
 *
 * @param {unknown} state
 * @returns {{ cookieCount: number, originCount: number, hasInstagramState: boolean }}
 */
export function validateStorageState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new StorageStateError(
      'Auth storage state is invalid: expected a JSON object.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  const cookies = /** @type {{ cookies?: unknown, origins?: unknown }} */ (state).cookies;
  const origins = /** @type {{ cookies?: unknown, origins?: unknown }} */ (state).origins;

  if (!Array.isArray(cookies)) {
    throw new StorageStateError(
      'Auth storage state is invalid: missing cookies array.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  if (origins !== undefined && !Array.isArray(origins)) {
    throw new StorageStateError(
      'Auth storage state is invalid: origins must be an array when present.',
      { code: 'INVALID_STORAGE_STATE' },
    );
  }

  const originList = Array.isArray(origins) ? origins : [];
  const hasInstagramCookie = cookies.some(isInstagramCookie);
  const hasInstagramOrigin = originList.some(isInstagramOrigin);

  if (!hasInstagramCookie && !hasInstagramOrigin) {
    throw new StorageStateError(
      'Auth storage state is invalid: no usable Instagram-origin cookies or origins were found.',
      { code: 'NO_INSTAGRAM_STATE' },
    );
  }

  if (cookies.length === 0 && originList.length === 0) {
    throw new StorageStateError(
      'Auth storage state is invalid: snapshot is empty.',
      { code: 'EMPTY_STORAGE_STATE' },
    );
  }

  return {
    cookieCount: cookies.length,
    originCount: originList.length,
    hasInstagramState: true,
  };
}

/**
 * Read and validate a storage-state file from disk.
 *
 * @param {string} filePath
 * @returns {Promise<{ state: object, summary: { cookieCount: number, originCount: number, hasInstagramState: boolean } }>}
 */
export async function readStorageStateFile(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    if (err.code === 'ENOENT') {
      throw new StorageStateError(
        [
          `Auth storage state file is missing: ${filePath}`,
          'Generate a new state on your local machine with `npm run login`,',
          'then securely copy it to the server with scp (never Telegram/GitHub/public file sharing).',
        ].join(' '),
        { code: 'MISSING_STORAGE_STATE', cause: error },
      );
    }

    throw new StorageStateError(
      `Failed to read auth storage state file: ${filePath}`,
      { code: 'READ_STORAGE_STATE_FAILED', cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageStateError(
      [
        `Auth storage state file is corrupted or not valid JSON: ${filePath}`,
        'Re-run `npm run login` locally and transfer a fresh file to the server.',
      ].join(' '),
      { code: 'CORRUPT_STORAGE_STATE', cause: error },
    );
  }

  const summary = validateStorageState(parsed);
  return { state: parsed, summary };
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isValidStorageStateFile(filePath) {
  try {
    await readStorageStateFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the parent directory exists with restrictive permissions.
 *
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function ensureStorageStateDirectory(filePath) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch {
    // Best-effort on filesystems that ignore mode bits.
  }
}

/**
 * Atomically write a validated storage-state object.
 * Never overwrites an existing valid file when the write/validation fails.
 *
 * @param {string} filePath
 * @param {unknown} state
 * @returns {Promise<{ cookieCount: number, originCount: number, hasInstagramState: boolean }>}
 */
export async function writeStorageStateAtomic(filePath, state) {
  const filtered = filterInstagramStorageState(state);
  const filteredState = {
    cookies: filtered.cookies,
    origins: filtered.origins,
  };
  const summary = validateStorageState(filteredState);
  await ensureStorageStateDirectory(filePath);

  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(filteredState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.promises.chmod(tmpPath, 0o600);

    const tempRaw = await fs.promises.readFile(tmpPath, 'utf8');
    validateStorageState(JSON.parse(tempRaw));

    await fs.promises.rename(tmpPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
    return {
      ...summary,
      removedCookieCount: filtered.removedCookieCount,
      removedOriginCount: filtered.removedOriginCount,
    };
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});

    if (error instanceof StorageStateError) {
      throw error;
    }

    throw new StorageStateError(
      `Failed to write auth storage state file: ${filePath}`,
      { code: 'WRITE_STORAGE_STATE_FAILED', cause: error },
    );
  }
}

/**
 * Verify a written storage-state file exists, is non-empty, mode 0600, and valid.
 *
 * @param {string} filePath
 * @returns {Promise<{ absolutePath: string, bytes: number, mode: number, summary: { cookieCount: number, originCount: number, hasInstagramState: boolean } }>}
 */
export async function verifyExportedStorageStateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch (error) {
    throw new StorageStateError(
      `Auth storage state file was not found after export: ${absolutePath}`,
      { code: 'EXPORT_VERIFY_MISSING', cause: error },
    );
  }

  if (!stats.isFile() || stats.size <= 0) {
    throw new StorageStateError(
      `Auth storage state file is empty or not a regular file: ${absolutePath}`,
      { code: 'EXPORT_VERIFY_EMPTY' },
    );
  }

  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    try {
      await fs.promises.chmod(absolutePath, 0o600);
    } catch (error) {
      throw new StorageStateError(
        `Auth storage state file permissions are ${mode.toString(8)}, expected 600: ${absolutePath}`,
        { code: 'EXPORT_VERIFY_PERMISSIONS', cause: error },
      );
    }
  }

  const { summary } = await readStorageStateFile(absolutePath);
  return {
    absolutePath,
    bytes: stats.size,
    mode: (await fs.promises.stat(absolutePath)).mode & 0o777,
    summary,
  };
}

/**
 * Export Playwright context storage state (including IndexedDB when supported),
 * keep only Instagram cookies/origins, then replace the destination file only
 * after validation succeeds.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} filePath
 * @param {{
 *   storageState?: (options?: { path?: string, indexedDB?: boolean }) => Promise<object>,
 *   logger?: {
 *     info?: (message: string, meta?: Record<string, unknown>) => void,
 *     warn?: (message: string, meta?: Record<string, unknown>) => void,
 *     error?: (message: string, meta?: Record<string, unknown>) => void,
 *     debug?: (message: string, meta?: Record<string, unknown>) => void,
 *   },
 * }} [deps]
 * @returns {Promise<{
 *   cookieCount: number,
 *   originCount: number,
 *   hasInstagramState: boolean,
 *   removedCookieCount: number,
 *   removedOriginCount: number,
 *   absolutePath: string,
 *   bytes: number,
 *   mode: number,
 * }>}
 */
export async function exportContextStorageState(context, filePath, deps = {}) {
  const storageState =
    deps.storageState ?? context.storageState.bind(context);
  const logger = deps.logger ?? null;
  const absolutePath = path.resolve(filePath);

  logger?.info?.('Auth storage-state export started', { path: absolutePath });
  await ensureStorageStateDirectory(filePath);

  const dir = path.dirname(filePath);
  const rawTmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.raw.${process.pid}.${Date.now()}.tmp`,
  );
  const filteredTmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    // Capture into a temporary raw file first so an unfiltered personal-Chrome
    // snapshot never becomes the final destination.
    const state = await storageState({
      path: rawTmpPath,
      indexedDB: true,
    });

    let parsed = state;
    if (fs.existsSync(rawTmpPath)) {
      parsed = JSON.parse(await fs.promises.readFile(rawTmpPath, 'utf8'));
    } else if (!parsed || typeof parsed !== 'object') {
      throw new StorageStateError(
        'Auth storage state export returned an empty snapshot.',
        { code: 'EMPTY_STORAGE_STATE' },
      );
    }

    const filtered = filterInstagramStorageState(parsed);
    logger?.info?.('Instagram cookies collected', {
      cookieCount: filtered.cookies.length,
      removedCookieCount: filtered.removedCookieCount,
    });
    logger?.info?.('Instagram origins collected', {
      originCount: filtered.origins.length,
      removedOriginCount: filtered.removedOriginCount,
    });

    const filteredState = {
      cookies: filtered.cookies,
      origins: filtered.origins,
    };

    let summary;
    try {
      summary = validateStorageState(filteredState);
      logger?.info?.('Auth storage-state validation passed', {
        cookieCount: summary.cookieCount,
        originCount: summary.originCount,
      });
    } catch (error) {
      logger?.error?.('Auth storage-state validation failed', {
        code: error instanceof StorageStateError ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    await fs.promises.writeFile(
      filteredTmpPath,
      `${JSON.stringify(filteredState, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.promises.chmod(filteredTmpPath, 0o600);
    logger?.info?.('Temporary auth storage-state file written', {
      temporaryPathConfigured: true,
    });
    validateStorageState(JSON.parse(await fs.promises.readFile(filteredTmpPath, 'utf8')));

    await fs.promises.rename(filteredTmpPath, filePath);
    logger?.info?.('Atomic rename completed', { path: absolutePath });
    await fs.promises.chmod(filePath, 0o600);
    logger?.info?.('File permissions applied', { mode: '0600' });

    const verified = await verifyExportedStorageStateFile(filePath);
    logger?.info?.('Final auth storage-state file verified', {
      path: verified.absolutePath,
      bytes: verified.bytes,
      mode: verified.mode.toString(8).padStart(3, '0'),
      cookieCount: verified.summary.cookieCount,
      originCount: verified.summary.originCount,
    });

    return {
      ...summary,
      removedCookieCount: filtered.removedCookieCount,
      removedOriginCount: filtered.removedOriginCount,
      absolutePath: verified.absolutePath,
      bytes: verified.bytes,
      mode: verified.mode,
    };
  } catch (error) {
    await fs.promises.unlink(rawTmpPath).catch(() => {});
    await fs.promises.unlink(filteredTmpPath).catch(() => {});

    if (error instanceof StorageStateError) {
      throw error;
    }

    throw new StorageStateError(
      `Failed to export auth storage state to ${absolutePath}`,
      { code: 'EXPORT_STORAGE_STATE_FAILED', cause: error },
    );
  } finally {
    await fs.promises.unlink(rawTmpPath).catch(() => {});
  }
}

/**
 * Actionable guidance when a server session is no longer authenticated.
 *
 * @param {string} state
 * @param {string} filePath
 * @returns {string}
 */
export function sessionInvalidationMessage(state, filePath) {
  return [
    `Instagram authentication is no longer valid (state=${state}).`,
    'Authentication-dependent bot actions are stopping.',
    'The last known valid storage-state file will not be overwritten with an invalid snapshot.',
    'Run `npm run login` on your local Ubuntu machine, complete login/CAPTCHA/2FA manually,',
    `then securely transfer the new file to ${filePath} with scp and restart the bot.`,
    'Do not use Telegram, GitHub, or public file-sharing services to transfer auth state.',
    'Sessions may be rejected after device or IP changes; Instagram does not guarantee a fixed lifetime.',
  ].join(' ');
}
