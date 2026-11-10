import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);
const VALID_BROWSER_PLATFORMS = new Set(['x11', 'wayland', 'default']);
const VALID_BROWSER_MODES = new Set(['existing', 'launch', 'launch-x11', 'storage-state']);
const BUNDLED_CHANNEL_ALIASES = new Set(['chromium', 'bundled']);
const LAUNCH_X11_EXECUTABLE = '/usr/bin/google-chrome-stable';
const LAUNCH_X11_USER_DATA_DIR = './sessions/instagram-x11';
const DEFAULT_USER_DATA_DIR = './sessions/instagram';
const DEFAULT_AUTH_STORAGE_STATE_PATH = './data/instagram-auth.json';
const DEFAULT_AUTH_STATE_SAVE_INTERVAL_MS = 300_000;

/**
 * @param {string | undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new ConfigError(`Invalid boolean value: "${value}"`);
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid ${name}: expected a positive integer, got "${value}"`);
  }

  return parsed;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function parseLogLevel(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!VALID_LOG_LEVELS.has(normalized)) {
    throw new ConfigError(
      `Invalid LOG_LEVEL: "${value}". Expected one of: ${[...VALID_LOG_LEVELS].join(', ')}`,
    );
  }

  return normalized;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function parseBaseUrl(value, fallback) {
  const candidate = (value === undefined || value === '' ? fallback : value).trim();

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError(`Invalid INSTAGRAM_BASE_URL: "${candidate}"`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ConfigError(`Invalid INSTAGRAM_BASE_URL protocol: "${url.protocol}"`);
  }

  return url.origin;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function resolveUserDataDir(value, fallback) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

/**
 * Resolve browser channel.
 * - Default: chrome (system Google Chrome via Playwright channel)
 * - Explicit bundled Chromium: chromium | bundled
 *
 * @param {string | undefined} value
 * @returns {string | null}
 */
function parseBrowserChannel(value) {
  if (value === undefined || value === '') {
    return 'chrome';
  }

  const normalized = value.trim().toLowerCase();
  if (BUNDLED_CHANNEL_ALIASES.has(normalized)) {
    return null;
  }

  return value.trim();
}

/**
 * @param {string | undefined} value
 * @returns {string | null}
 */
function parseBrowserExecutablePath(value) {
  if (value === undefined || value === '') {
    return null;
  }

  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new ConfigError(
      `Invalid BROWSER_EXECUTABLE_PATH: expected an absolute path, got "${trimmed}"`,
    );
  }

  return trimmed;
}

/**
 * @param {string | undefined} value
 * @param {NodeJS.Platform} [platform=process.platform]
 * @returns {'x11' | 'wayland' | 'default'}
 */
function parseBrowserPlatform(value, platform = process.platform) {
  const fallback = platform === 'linux' ? 'x11' : 'default';

  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!VALID_BROWSER_PLATFORMS.has(normalized)) {
    throw new ConfigError(
      `Invalid BROWSER_PLATFORM: "${value}". Expected one of: ${[...VALID_BROWSER_PLATFORMS].join(', ')}`,
    );
  }

  return /** @type {'x11' | 'wayland' | 'default'} */ (normalized);
}

/**
 * @param {string | undefined} value
 * @returns {'existing' | 'launch' | 'launch-x11' | 'storage-state'}
 */
function parseBrowserMode(value) {
  if (value === undefined || value === '') {
    // Attach to the user's already-running Chrome window by default.
    return 'existing';
  }

  const normalized = value.trim().toLowerCase();
  if (!VALID_BROWSER_MODES.has(normalized)) {
    throw new ConfigError(
      `Invalid BROWSER_MODE: "${value}". Expected one of: ${[...VALID_BROWSER_MODES].join(', ')}`,
    );
  }

  return /** @type {'existing' | 'launch' | 'launch-x11' | 'storage-state'} */ (normalized);
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function resolveAuthStorageStatePath(value, fallback) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

/**
 * Optional CDP endpoint for existing-browser mode.
 * Defaults to the browser channel name (e.g. "chrome").
 *
 * @param {string | undefined} value
 * @param {string | null} browserChannel
 * @returns {string}
 */
function parseCdpEndpoint(value, browserChannel) {
  if (value === undefined || value === '') {
    return browserChannel || 'chrome';
  }

  return value.trim();
}

export class ConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate application configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Readonly<{
 *   instagramBaseUrl: string,
 *   headless: boolean,
 *   viewport: { width: number, height: number },
 *   userDataDir: string,
 *   browserMode: 'existing' | 'launch' | 'launch-x11' | 'storage-state',
 *   browserChannel: string | null,
 *   browserExecutablePath: string | null,
 *   browserPlatform: 'x11' | 'wayland' | 'default',
 *   cdpEndpoint: string,
 *   authStorageStatePath: string,
 *   authStateSaveIntervalMs: number,
 *   loginTimeoutMs: number,
 *   navigationTimeoutMs: number,
 *   logLevel: string,
 *   autoLogin: boolean,
 *   username: string | null,
 *   password: string | null,
 *   projectRoot: string,
 * }>}
 */
export function loadConfig(env = process.env) {
  const username = env.INSTAGRAM_USERNAME?.trim() || null;
  const password = env.INSTAGRAM_PASSWORD?.trim() || null;

  if ((username && !password) || (!username && password)) {
    throw new ConfigError(
      'Incomplete Instagram credentials: both INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set together for automatic login, or both left empty for manual login.',
    );
  }

  const autoLogin = parseBoolean(env.AUTO_LOGIN, true);

  const browserChannel = parseBrowserChannel(env.BROWSER_CHANNEL);
  const browserMode = parseBrowserMode(env.BROWSER_MODE);
  const isLaunchX11 = browserMode === 'launch-x11';
  const isStorageState = browserMode === 'storage-state';

  let browserExecutablePath = parseBrowserExecutablePath(env.BROWSER_EXECUTABLE_PATH);
  let browserPlatform = parseBrowserPlatform(env.BROWSER_PLATFORM);
  // storage-state defaults to headless; personal Chrome / launch modes stay headed by default.
  const headless = parseBoolean(env.HEADLESS, isStorageState);

  if (isLaunchX11) {
    // Preset for the verified Ubuntu X11 + system Chrome path.
    if (!browserExecutablePath) {
      browserExecutablePath = LAUNCH_X11_EXECUTABLE;
    }
    browserPlatform = 'x11';
  }

  if (isStorageState && !browserExecutablePath) {
    browserExecutablePath = LAUNCH_X11_EXECUTABLE;
  }

  const configuredUserDataDir = env.USER_DATA_DIR?.trim() || '';
  let userDataDir;
  if (isLaunchX11) {
    // Keep launch-x11 isolated from the CDP/generic ./sessions/instagram profile.
    const usesGenericDefault =
      !configuredUserDataDir ||
      configuredUserDataDir === DEFAULT_USER_DATA_DIR ||
      configuredUserDataDir === 'sessions/instagram';
    userDataDir = resolveUserDataDir(
      usesGenericDefault ? LAUNCH_X11_USER_DATA_DIR : configuredUserDataDir,
      LAUNCH_X11_USER_DATA_DIR,
    );
  } else {
    userDataDir = resolveUserDataDir(configuredUserDataDir, DEFAULT_USER_DATA_DIR);
  }

  const config = Object.freeze({
    instagramBaseUrl: parseBaseUrl(env.INSTAGRAM_BASE_URL, 'https://www.instagram.com'),
    headless,
    viewport: Object.freeze({
      width: parsePositiveInteger(env.VIEWPORT_WIDTH, 1280, 'VIEWPORT_WIDTH'),
      height: parsePositiveInteger(env.VIEWPORT_HEIGHT, 800, 'VIEWPORT_HEIGHT'),
    }),
    userDataDir,
    browserMode,
    browserChannel,
    browserExecutablePath,
    browserPlatform,
    cdpEndpoint: parseCdpEndpoint(env.BROWSER_CDP_ENDPOINT, browserChannel),
    authStorageStatePath: resolveAuthStorageStatePath(
      env.AUTH_STORAGE_STATE_PATH,
      DEFAULT_AUTH_STORAGE_STATE_PATH,
    ),
    authStateSaveIntervalMs: parsePositiveInteger(
      env.AUTH_STATE_SAVE_INTERVAL_MS,
      DEFAULT_AUTH_STATE_SAVE_INTERVAL_MS,
      'AUTH_STATE_SAVE_INTERVAL_MS',
    ),
    loginTimeoutMs: parsePositiveInteger(env.LOGIN_TIMEOUT, 300_000, 'LOGIN_TIMEOUT'),
    navigationTimeoutMs: parsePositiveInteger(
      env.NAVIGATION_TIMEOUT,
      60_000,
      'NAVIGATION_TIMEOUT',
    ),
    logLevel: parseLogLevel(env.LOG_LEVEL, 'info'),
    autoLogin,
    username,
    password,
    projectRoot: PROJECT_ROOT,
  });

  return config;
}

export {
  PROJECT_ROOT,
  VALID_LOG_LEVELS,
  VALID_BROWSER_PLATFORMS,
  VALID_BROWSER_MODES,
  LAUNCH_X11_EXECUTABLE,
  LAUNCH_X11_USER_DATA_DIR,
  DEFAULT_AUTH_STORAGE_STATE_PATH,
  DEFAULT_AUTH_STATE_SAVE_INTERVAL_MS,
  parseBrowserPlatform,
};
