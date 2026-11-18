import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveDatabasePath, DEFAULT_DATABASE_PATH } from '../storage/database.js';

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
const DEFAULT_APP_TIMEZONE = 'Europe/Berlin';
const DEFAULT_CONTROL_SOCKET_PATH = './data/bot.sock';
const DEFAULT_CONTROL_TOKEN_PATH = './data/bot.control-token';
const DEFAULT_MEDIA_LIBRARY_DIR = './data/media';
const VALID_PUBLISHING_ADAPTERS = new Set(['mock', 'instagram-graph', 'instagram', 'official']);
const VALID_GRAPH_LOGIN_FLOWS = new Set(['facebook', 'instagram', 'facebook-login', 'instagram-login']);
const DEFAULT_GRAPH_API_VERSION = 'v21.0';
const VALID_AI_PROVIDERS = new Set(['openrouter', 'mock']);
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_AI_MAX_TOOL_ITERATIONS = 8;
const DEFAULT_AI_MAX_RETRIES = 2;

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function parseAiProvider(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!VALID_AI_PROVIDERS.has(normalized)) {
    throw new ConfigError(
      `Invalid AI_PROVIDER: "${value}". Expected one of: ${[...VALID_AI_PROVIDERS].join(', ')}`,
    );
  }
  return normalized;
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseCommaSeparatedList(value) {
  if (value === undefined || value === '') {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

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
 * @param {string | undefined} value
 * @param {string} projectRoot
 * @param {string} fallback
 * @returns {string}
 */
function resolveProjectPath(value, projectRoot, fallback) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function parseTimezone(value, fallback) {
  const candidate = (value === undefined || value === '' ? fallback : value).trim();
  try {
    // Throws RangeError for invalid IANA time zones.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
  } catch {
    throw new ConfigError(
      `Invalid APP_TIMEZONE: "${candidate}". Expected a valid IANA time zone (e.g. Europe/Berlin).`,
    );
  }
  return candidate;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function parsePublishingAdapter(value, fallback) {
  const candidate = (value === undefined || value === '' ? fallback : value).trim().toLowerCase();
  if (!VALID_PUBLISHING_ADAPTERS.has(candidate)) {
    throw new ConfigError(
      `Invalid PUBLISHING_ADAPTER: "${value}". Expected one of: mock, instagram-graph.`,
    );
  }
  if (candidate === 'instagram' || candidate === 'official') {
    return 'instagram-graph';
  }
  return candidate;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {'facebook' | 'instagram'}
 */
function parseGraphLoginFlow(value, fallback) {
  const candidate = (value === undefined || value === '' ? fallback : value).trim().toLowerCase();
  if (!VALID_GRAPH_LOGIN_FLOWS.has(candidate)) {
    throw new ConfigError(
      `Invalid INSTAGRAM_GRAPH_LOGIN_FLOW: "${value}". Expected facebook or instagram.`,
    );
  }
  if (candidate === 'instagram' || candidate === 'instagram-login') {
    return 'instagram';
  }
  return 'facebook';
}

/**
 * @param {string | undefined} value
 * @returns {string | null}
 */
function parseOptionalHttpsBaseUrl(value) {
  if (value === undefined || value === '') {
    return null;
  }
  const trimmed = value.trim().replace(/\/$/, '');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`Invalid MEDIA_PUBLIC_BASE_URL: "${value}"`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(
      `Invalid MEDIA_PUBLIC_BASE_URL: must use HTTPS (got ${url.protocol})`,
    );
  }
  return trimmed;
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
 *   appTimezone: string,
 *   workerConcurrency: number,
 *   taskMaxAttempts: number,
 *   taskRetryBaseMs: number,
 *   taskRetryMaxMs: number,
 *   taskStaleTimeoutMs: number,
 *   taskShutdownTimeoutMs: number,
 *   workerPollIntervalMs: number,
 *   schedulerPollIntervalMs: number,
 *   sessionMonitorIntervalMs: number,
 *   databasePath: string,
 *   controlSocketPath: string,
 *   controlTokenPath: string,
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
    appTimezone: parseTimezone(env.APP_TIMEZONE, DEFAULT_APP_TIMEZONE),
    workerConcurrency: parsePositiveInteger(
      env.WORKER_CONCURRENCY,
      1,
      'WORKER_CONCURRENCY',
    ),
    taskMaxAttempts: parsePositiveInteger(
      env.TASK_MAX_ATTEMPTS,
      3,
      'TASK_MAX_ATTEMPTS',
    ),
    taskRetryBaseMs: parsePositiveInteger(
      env.TASK_RETRY_BASE_MS,
      5_000,
      'TASK_RETRY_BASE_MS',
    ),
    taskRetryMaxMs: parsePositiveInteger(
      env.TASK_RETRY_MAX_MS,
      300_000,
      'TASK_RETRY_MAX_MS',
    ),
    taskStaleTimeoutMs: parsePositiveInteger(
      env.TASK_STALE_TIMEOUT_MS,
      60_000,
      'TASK_STALE_TIMEOUT_MS',
    ),
    taskShutdownTimeoutMs: parsePositiveInteger(
      env.TASK_SHUTDOWN_TIMEOUT_MS,
      30_000,
      'TASK_SHUTDOWN_TIMEOUT_MS',
    ),
    workerPollIntervalMs: parsePositiveInteger(
      env.WORKER_POLL_INTERVAL_MS,
      1_000,
      'WORKER_POLL_INTERVAL_MS',
    ),
    schedulerPollIntervalMs: parsePositiveInteger(
      env.SCHEDULER_POLL_INTERVAL_MS,
      1_000,
      'SCHEDULER_POLL_INTERVAL_MS',
    ),
    sessionMonitorIntervalMs: parsePositiveInteger(
      env.SESSION_MONITOR_INTERVAL_MS,
      30_000,
      'SESSION_MONITOR_INTERVAL_MS',
    ),
    databasePath: resolveDatabasePath(
      env.DATABASE_PATH,
      PROJECT_ROOT,
      DEFAULT_DATABASE_PATH,
    ),
    controlSocketPath: resolveProjectPath(
      env.CONTROL_SOCKET_PATH,
      PROJECT_ROOT,
      DEFAULT_CONTROL_SOCKET_PATH,
    ),
    controlTokenPath: resolveProjectPath(
      env.CONTROL_TOKEN_PATH,
      PROJECT_ROOT,
      DEFAULT_CONTROL_TOKEN_PATH,
    ),
    mediaLibraryDir: resolveProjectPath(
      env.MEDIA_LIBRARY_DIR,
      PROJECT_ROOT,
      DEFAULT_MEDIA_LIBRARY_DIR,
    ),
    publishingAdapter: parsePublishingAdapter(env.PUBLISHING_ADAPTER, 'mock'),
    contentDryRun: parseBoolean(env.CONTENT_DRY_RUN, true),
    instagramGraphAccessToken:
      env.INSTAGRAM_GRAPH_ACCESS_TOKEN === undefined ||
      env.INSTAGRAM_GRAPH_ACCESS_TOKEN === ''
        ? null
        : env.INSTAGRAM_GRAPH_ACCESS_TOKEN,
    instagramBusinessAccountId:
      env.INSTAGRAM_BUSINESS_ACCOUNT_ID === undefined ||
      env.INSTAGRAM_BUSINESS_ACCOUNT_ID === ''
        ? null
        : env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
    instagramGraphLoginFlow: parseGraphLoginFlow(
      env.INSTAGRAM_GRAPH_LOGIN_FLOW,
      'facebook',
    ),
    instagramGraphApiVersion:
      env.INSTAGRAM_GRAPH_API_VERSION === undefined ||
      env.INSTAGRAM_GRAPH_API_VERSION === ''
        ? DEFAULT_GRAPH_API_VERSION
        : env.INSTAGRAM_GRAPH_API_VERSION.trim(),
    instagramGraphApiBaseUrl:
      env.INSTAGRAM_GRAPH_API_BASE_URL === undefined ||
      env.INSTAGRAM_GRAPH_API_BASE_URL === ''
        ? null
        : env.INSTAGRAM_GRAPH_API_BASE_URL.trim().replace(/\/$/, ''),
    mediaPublicBaseUrl: parseOptionalHttpsBaseUrl(env.MEDIA_PUBLIC_BASE_URL),
    aiProvider: parseAiProvider(env.AI_PROVIDER, 'openrouter'),
    openrouterApiKey:
      env.OPENROUTER_API_KEY === undefined || env.OPENROUTER_API_KEY === ''
        ? null
        : env.OPENROUTER_API_KEY,
    openrouterBaseUrl:
      env.OPENROUTER_BASE_URL === undefined || env.OPENROUTER_BASE_URL === ''
        ? DEFAULT_OPENROUTER_BASE_URL
        : env.OPENROUTER_BASE_URL.trim().replace(/\/$/, ''),
    openrouterModel:
      env.OPENROUTER_MODEL === undefined || env.OPENROUTER_MODEL === ''
        ? null
        : env.OPENROUTER_MODEL.trim(),
    openrouterFallbackModels: Object.freeze(
      parseCommaSeparatedList(env.OPENROUTER_FALLBACK_MODELS),
    ),
    openrouterAppName:
      env.OPENROUTER_APP_NAME === undefined || env.OPENROUTER_APP_NAME === ''
        ? 'Instagram Automation Agent'
        : env.OPENROUTER_APP_NAME.trim(),
    openrouterAppUrl:
      env.OPENROUTER_APP_URL === undefined || env.OPENROUTER_APP_URL === ''
        ? null
        : env.OPENROUTER_APP_URL.trim(),
    aiRequestTimeoutMs: parsePositiveInteger(
      env.AI_REQUEST_TIMEOUT_MS,
      DEFAULT_AI_REQUEST_TIMEOUT_MS,
      'AI_REQUEST_TIMEOUT_MS',
    ),
    aiMaxToolIterations: parsePositiveInteger(
      env.AI_MAX_TOOL_ITERATIONS,
      DEFAULT_AI_MAX_TOOL_ITERATIONS,
      'AI_MAX_TOOL_ITERATIONS',
    ),
    aiMaxRetries: parsePositiveInteger(
      env.AI_MAX_RETRIES,
      DEFAULT_AI_MAX_RETRIES,
      'AI_MAX_RETRIES',
    ),
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
  DEFAULT_APP_TIMEZONE,
  DEFAULT_DATABASE_PATH,
  DEFAULT_CONTROL_SOCKET_PATH,
  DEFAULT_CONTROL_TOKEN_PATH,
  DEFAULT_MEDIA_LIBRARY_DIR,
  DEFAULT_OPENROUTER_BASE_URL,
  VALID_AI_PROVIDERS,
  parseBrowserPlatform,
};
