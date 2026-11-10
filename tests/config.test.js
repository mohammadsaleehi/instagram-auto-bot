import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  ConfigError,
  loadConfig,
  parseBrowserPlatform,
  PROJECT_ROOT,
} from '../src/config/config.js';

describe('loadConfig', () => {
  it('loads default configuration when env is empty', () => {
    const config = loadConfig({});

    expect(config.instagramBaseUrl).toBe('https://www.instagram.com');
    expect(config.headless).toBe(false);
    expect(config.viewport).toEqual({ width: 1280, height: 800 });
    expect(config.userDataDir).toBe(path.resolve(PROJECT_ROOT, './sessions/instagram'));
    expect(config.loginTimeoutMs).toBe(300_000);
    expect(config.navigationTimeoutMs).toBe(60_000);
    expect(config.logLevel).toBe('info');
    expect(config.username).toBeNull();
    expect(config.password).toBeNull();
    expect(config.autoLogin).toBe(true);
    expect(config.browserChannel).toBe('chrome');
    expect(config.browserExecutablePath).toBeNull();
    expect(['x11', 'default']).toContain(config.browserPlatform);
    expect(config.browserMode).toBe('existing');
    expect(config.cdpEndpoint).toBe('chrome');
    expect(config.authStorageStatePath).toBe(
      path.resolve(PROJECT_ROOT, './data/instagram-auth.json'),
    );
    expect(config.authStateSaveIntervalMs).toBe(300_000);
  });

  it('defaults browser mode to existing and channel to chrome', () => {
    const config = loadConfig({});
    expect(config.browserMode).toBe('existing');
    expect(config.browserChannel).toBe('chrome');
    expect(config.cdpEndpoint).toBe('chrome');
  });

  it('parses launch browser mode', () => {
    const config = loadConfig({ BROWSER_MODE: 'launch' });
    expect(config.browserMode).toBe('launch');
  });

  it('parses optional storage-state mode without changing the existing default', () => {
    expect(loadConfig({}).browserMode).toBe('existing');

    const config = loadConfig({ BROWSER_MODE: 'storage-state' });
    expect(config.browserMode).toBe('storage-state');
    expect(config.headless).toBe(true);
    expect(config.browserExecutablePath).toBe('/usr/bin/google-chrome-stable');
    expect(config.authStorageStatePath).toBe(
      path.resolve(PROJECT_ROOT, './data/instagram-auth.json'),
    );
    expect(config.authStateSaveIntervalMs).toBe(300_000);
  });

  it('parses explicit auth storage path and save interval', () => {
    const config = loadConfig({
      AUTH_STORAGE_STATE_PATH: '/var/bot/instagram-auth.json',
      AUTH_STATE_SAVE_INTERVAL_MS: '120000',
    });

    expect(config.authStorageStatePath).toBe('/var/bot/instagram-auth.json');
    expect(config.authStateSaveIntervalMs).toBe(120_000);
  });

  it('applies launch-x11 presets for Chrome executable, X11 and isolated profile', () => {
    const config = loadConfig({ BROWSER_MODE: 'launch-x11' });

    expect(config.browserMode).toBe('launch-x11');
    expect(config.browserExecutablePath).toBe('/usr/bin/google-chrome-stable');
    expect(config.browserPlatform).toBe('x11');
    expect(config.headless).toBe(false);
    expect(config.userDataDir).toBe(
      path.resolve(PROJECT_ROOT, './sessions/instagram-x11'),
    );
  });

  it('does not reuse ./sessions/instagram when launch-x11 inherits a generic USER_DATA_DIR', () => {
    const config = loadConfig({
      BROWSER_MODE: 'launch-x11',
      USER_DATA_DIR: './sessions/instagram',
    });

    expect(config.userDataDir).toBe(
      path.resolve(PROJECT_ROOT, './sessions/instagram-x11'),
    );
  });

  it('allows an explicit custom profile for launch-x11', () => {
    const config = loadConfig({
      BROWSER_MODE: 'launch-x11',
      USER_DATA_DIR: '/tmp/custom-x11-profile',
      BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
    });

    expect(config.userDataDir).toBe('/tmp/custom-x11-profile');
    expect(config.browserExecutablePath).toBe('/usr/bin/google-chrome-stable');
    expect(config.browserPlatform).toBe('x11');
  });

  it('keeps an explicit Snap Chromium executable path', () => {
    const config = loadConfig({
      BROWSER_EXECUTABLE_PATH: '/snap/bin/chromium',
      BROWSER_CHANNEL: 'chrome',
      BROWSER_PLATFORM: 'x11',
    });
    expect(config.browserExecutablePath).toBe('/snap/bin/chromium');
    expect(config.browserPlatform).toBe('x11');
  });

  it('rejects invalid browser modes', () => {
    expect(() => loadConfig({ BROWSER_MODE: 'attach' })).toThrow(ConfigError);
  });

  it('parses an explicit CDP endpoint', () => {
    const config = loadConfig({ BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222' });
    expect(config.cdpEndpoint).toBe('http://127.0.0.1:9222');
  });

  it('selects chrome channel when BROWSER_CHANNEL=chrome', () => {
    const config = loadConfig({ BROWSER_CHANNEL: 'chrome' });
    expect(config.browserChannel).toBe('chrome');
  });

  it('uses bundled Chromium when BROWSER_CHANNEL is chromium or bundled', () => {
    expect(loadConfig({ BROWSER_CHANNEL: 'chromium' }).browserChannel).toBeNull();
    expect(loadConfig({ BROWSER_CHANNEL: 'bundled' }).browserChannel).toBeNull();
  });

  it('parses an explicit browser executable path', () => {
    const config = loadConfig({
      BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
    });
    expect(config.browserExecutablePath).toBe('/usr/bin/google-chrome-stable');
  });

  it('rejects a relative browser executable path', () => {
    expect(() => loadConfig({ BROWSER_EXECUTABLE_PATH: 'google-chrome' })).toThrow(ConfigError);
  });

  it('parses browser platform values', () => {
    expect(loadConfig({ BROWSER_PLATFORM: 'x11' }).browserPlatform).toBe('x11');
    expect(loadConfig({ BROWSER_PLATFORM: 'wayland' }).browserPlatform).toBe('wayland');
    expect(loadConfig({ BROWSER_PLATFORM: 'default' }).browserPlatform).toBe('default');
  });

  it('rejects invalid browser platforms', () => {
    expect(() => loadConfig({ BROWSER_PLATFORM: 'mir' })).toThrow(ConfigError);
  });

  it('defaults browser platform to x11 on linux and default elsewhere', () => {
    expect(parseBrowserPlatform(undefined, 'linux')).toBe('x11');
    expect(parseBrowserPlatform('', 'linux')).toBe('x11');
    expect(parseBrowserPlatform(undefined, 'darwin')).toBe('default');
    expect(parseBrowserPlatform(undefined, 'win32')).toBe('default');
  });

  it('keeps the default persistent session directory', () => {
    const config = loadConfig({});
    expect(config.userDataDir).toBe(path.resolve(PROJECT_ROOT, './sessions/instagram'));
  });

  it('parses valid environment overrides', () => {
    const config = loadConfig({
      INSTAGRAM_BASE_URL: 'https://instagram.com/',
      HEADLESS: 'true',
      VIEWPORT_WIDTH: '1440',
      VIEWPORT_HEIGHT: '900',
      USER_DATA_DIR: '/tmp/ig-session',
      BROWSER_MODE: 'launch',
      BROWSER_CHANNEL: 'chrome',
      BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
      BROWSER_PLATFORM: 'x11',
      LOGIN_TIMEOUT: '120000',
      NAVIGATION_TIMEOUT: '45000',
      LOG_LEVEL: 'debug',
      INSTAGRAM_USERNAME: 'demo_user',
      INSTAGRAM_PASSWORD: 'demo_pass',
    });

    expect(config.instagramBaseUrl).toBe('https://instagram.com');
    expect(config.headless).toBe(true);
    expect(config.viewport).toEqual({ width: 1440, height: 900 });
    expect(config.userDataDir).toBe('/tmp/ig-session');
    expect(config.browserMode).toBe('launch');
    expect(config.browserChannel).toBe('chrome');
    expect(config.cdpEndpoint).toBe('http://127.0.0.1:9222');
    expect(config.browserExecutablePath).toBe('/usr/bin/google-chrome-stable');
    expect(config.browserPlatform).toBe('x11');
    expect(config.loginTimeoutMs).toBe(120_000);
    expect(config.navigationTimeoutMs).toBe(45_000);
    expect(config.logLevel).toBe('debug');
    expect(config.username).toBe('demo_user');
    expect(config.password).toBe('demo_pass');
  });

  it('resolves relative user data directories against the project root', () => {
    const config = loadConfig({ USER_DATA_DIR: 'custom/session' });
    expect(config.userDataDir).toBe(path.resolve(PROJECT_ROOT, 'custom/session'));
  });

  it('rejects invalid boolean values', () => {
    expect(() => loadConfig({ HEADLESS: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects non-positive viewport sizes', () => {
    expect(() => loadConfig({ VIEWPORT_WIDTH: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ VIEWPORT_HEIGHT: '-10' })).toThrow(ConfigError);
  });

  it('rejects invalid log levels', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('rejects invalid base URLs', () => {
    expect(() => loadConfig({ INSTAGRAM_BASE_URL: 'not-a-url' })).toThrow(ConfigError);
    expect(() => loadConfig({ INSTAGRAM_BASE_URL: 'ftp://instagram.com' })).toThrow(ConfigError);
  });

  it('requires username and password together for opt-in credential entry', () => {
    expect(() => loadConfig({ INSTAGRAM_USERNAME: 'only-user' })).toThrow(ConfigError);
    expect(() => loadConfig({ INSTAGRAM_PASSWORD: 'only-pass' })).toThrow(ConfigError);
  });

  it('parses AUTO_LOGIN and keeps credential values out of the thrown incomplete-credential message', () => {
    expect(loadConfig({ AUTO_LOGIN: 'false' }).autoLogin).toBe(false);
    expect(loadConfig({ AUTO_LOGIN: 'true' }).autoLogin).toBe(true);

    try {
      loadConfig({ INSTAGRAM_USERNAME: 'secret-user-value' });
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).not.toContain('secret-user-value');
    }
  });
});
