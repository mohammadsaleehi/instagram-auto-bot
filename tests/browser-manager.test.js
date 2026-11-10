import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  BrowserManager,
  buildPersistentContextOptions,
  buildPlatformArgs,
  detectSystemBrowserExecutable,
  remoteDebuggingErrorMessage,
  resolveCdpEndpoint,
} from '../src/browser/browser-manager.js';
import { StorageStateError } from '../src/auth/storage-state.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('buildPlatformArgs', () => {
  it('adds the X11 ozone platform argument', () => {
    expect(buildPlatformArgs('x11')).toEqual(['--ozone-platform=x11']);
  });

  it('adds the Wayland ozone platform argument', () => {
    expect(buildPlatformArgs('wayland')).toEqual(['--ozone-platform=wayland']);
  });

  it('omits platform arguments for default', () => {
    expect(buildPlatformArgs('default')).toEqual([]);
  });

  it('avoids duplicate ozone platform arguments', () => {
    expect(
      buildPlatformArgs('x11', ['--ozone-platform=wayland', '--disable-dev-shm-usage']),
    ).toEqual(['--disable-dev-shm-usage', '--ozone-platform=x11']);
  });
});

describe('buildPersistentContextOptions', () => {
  it('selects the chrome channel', () => {
    const options = buildPersistentContextOptions({
      browserChannel: 'chrome',
      browserPlatform: 'x11',
    });

    expect(options.channel).toBe('chrome');
    expect(options.executablePath).toBeUndefined();
    expect(options.args).toContain('--ozone-platform=x11');
    expect(options.headless).toBe(false);
  });

  it('uses an explicit executable path and skips channel', () => {
    const options = buildPersistentContextOptions({
      browserChannel: 'chrome',
      browserExecutablePath: '/usr/bin/google-chrome-stable',
      browserPlatform: 'x11',
    });

    expect(options.executablePath).toBe('/usr/bin/google-chrome-stable');
    expect(options.channel).toBeUndefined();
    expect(options.args).toEqual(['--ozone-platform=x11']);
  });

  it('uses wayland platform argument', () => {
    const options = buildPersistentContextOptions({
      browserChannel: 'chrome',
      browserPlatform: 'wayland',
    });

    expect(options.args).toEqual(['--ozone-platform=wayland']);
  });

  it('omits platform argument when browserPlatform is default', () => {
    const options = buildPersistentContextOptions({
      browserChannel: 'chrome',
      browserPlatform: 'default',
    });

    expect(options.args).toEqual([]);
  });

  it('uses bundled Chromium when channel is null and no executable path is set', () => {
    const options = buildPersistentContextOptions({
      browserChannel: null,
      browserExecutablePath: null,
      browserPlatform: 'default',
    });

    expect(options.channel).toBeUndefined();
    expect(options.executablePath).toBeUndefined();
  });
});

describe('resolveCdpEndpoint', () => {
  it('defaults to chrome', () => {
    expect(resolveCdpEndpoint({})).toBe('chrome');
  });

  it('prefers an explicit CDP endpoint', () => {
    expect(
      resolveCdpEndpoint({ cdpEndpoint: 'http://127.0.0.1:9222', browserChannel: 'chrome' }),
    ).toBe('http://127.0.0.1:9222');
  });
});

describe('BrowserManager existing CDP mode', () => {
  it('connects over CDP, reuses the default context, and opens a new tab', async () => {
    const logger = createLogger();
    const preexistingPage = { url: () => 'https://chatgpt.com/', isClosed: () => false };
    const newPage = { url: () => 'about:blank', isClosed: () => false };
    const newContext = vi.fn();
    const context = {
      pages: () => [preexistingPage],
      newPage: vi.fn(async () => newPage),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const browser = {
      contexts: () => [context],
      newContext,
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };
    const connectOverCDP = vi.fn(async () => browser);
    const launchPersistentContext = vi.fn();

    const manager = new BrowserManager({
      mode: 'existing',
      browserChannel: 'chrome',
      cdpEndpoint: 'chrome',
      logger,
      connectOverCDP,
      launchPersistentContext,
    });

    const page = await manager.start();

    expect(page).toBe(newPage);
    expect(connectOverCDP).toHaveBeenCalledWith('chrome');
    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(newContext).not.toHaveBeenCalled();
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(manager.getContext()).toBe(context);
    expect(manager.getPreexistingPages()).toEqual([preexistingPage]);

    await manager.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });

  it('preserves preexisting tabs when opening Instagram in a new tab', async () => {
    const logger = createLogger();
    const tabA = { url: () => 'https://chatgpt.com/', isClosed: () => false };
    const tabB = { url: () => 'https://example.com/', isClosed: () => false };
    const instagramTab = { url: () => 'about:blank', isClosed: () => false };
    const pages = [tabA, tabB];
    const context = {
      pages: () => pages,
      newPage: vi.fn(async () => {
        pages.push(instagramTab);
        return instagramTab;
      }),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const browser = {
      contexts: () => [context],
      newContext: vi.fn(),
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };

    const manager = new BrowserManager({
      mode: 'existing',
      cdpEndpoint: 'chrome',
      logger,
      connectOverCDP: vi.fn(async () => browser),
      launchPersistentContext: vi.fn(),
    });

    await manager.start();

    expect(manager.getPreexistingPages()).toEqual([tabA, tabB]);
    expect(context.pages()).toEqual([tabA, tabB, instagramTab]);
    expect(browser.newContext).not.toHaveBeenCalled();

    await manager.close();
    expect(context.pages().slice(0, 2)).toEqual([tabA, tabB]);
  });

  it('disconnects without closing the existing Chrome window', async () => {
    const logger = createLogger();
    const context = {
      pages: () => [],
      newPage: vi.fn(async () => ({ isClosed: () => false })),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const browser = {
      contexts: () => [context],
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };

    const manager = new BrowserManager({
      mode: 'existing',
      cdpEndpoint: 'chrome',
      logger,
      connectOverCDP: vi.fn(async () => browser),
    });

    await manager.start();
    await manager.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
    expect(manager.isRunning()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'Disconnected from existing Chrome (browser left open)',
    );
  });

  it('does not launch another browser process in existing mode', async () => {
    const launchPersistentContext = vi.fn();
    const context = {
      pages: () => [],
      newPage: vi.fn(async () => ({ isClosed: () => false })),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
    };
    const browser = {
      contexts: () => [context],
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };

    const manager = new BrowserManager({
      mode: 'existing',
      cdpEndpoint: 'chrome',
      logger: createLogger(),
      connectOverCDP: vi.fn(async () => browser),
      launchPersistentContext,
    });

    await manager.start();
    expect(launchPersistentContext).not.toHaveBeenCalled();
    await manager.close();
  });

  it('explains how to enable remote debugging when CDP attach fails', async () => {
    const manager = new BrowserManager({
      mode: 'existing',
      cdpEndpoint: 'chrome',
      logger: createLogger(),
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });

    await expect(manager.start()).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
    await expect(manager.start()).rejects.toThrow(/Allow remote debugging/);
    expect(remoteDebuggingErrorMessage('chrome')).toContain('will not launch a separate Chrome');
  });
});

describe('BrowserManager launch mode', () => {
  it('launches with persistent user data dir and configured options', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bot-browser-'));
    const logger = createLogger();

    const fakePage = {
      isClosed: () => false,
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const launchPersistentContext = vi.fn(async () => fakeContext);
    const connectOverCDP = vi.fn();

    const manager = new BrowserManager({
      mode: 'launch',
      userDataDir,
      headless: false,
      viewport: { width: 1280, height: 800 },
      browserChannel: 'chrome',
      browserExecutablePath: null,
      browserPlatform: 'x11',
      logger,
      launchPersistentContext,
      connectOverCDP,
    });

    const page = await manager.launch();

    expect(page).toBe(fakePage);
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(launchPersistentContext.mock.calls[0][0]).toBe(userDataDir);
    expect(launchPersistentContext.mock.calls[0][1]).toEqual({
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: ['--ozone-platform=x11'],
      channel: 'chrome',
    });
    expect(fs.existsSync(userDataDir)).toBe(true);

    await manager.close();
    expect(fakeContext.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(userDataDir)).toBe(true);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('passes an explicit executable path to launchPersistentContext', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bot-browser-'));
    const logger = createLogger();
    const fakePage = { isClosed: () => false };
    const fakeContext = {
      pages: () => [fakePage],
      newPage: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const launchPersistentContext = vi.fn(async () => fakeContext);

    const manager = new BrowserManager({
      mode: 'launch',
      userDataDir,
      browserExecutablePath: '/usr/bin/google-chrome-stable',
      browserChannel: 'chrome',
      browserPlatform: 'x11',
      logger,
      launchPersistentContext,
    });

    await manager.launch();

    expect(launchPersistentContext.mock.calls[0][1]).toMatchObject({
      executablePath: '/usr/bin/google-chrome-stable',
      args: ['--ozone-platform=x11'],
    });
    expect(launchPersistentContext.mock.calls[0][1].channel).toBeUndefined();

    await manager.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('reuses an existing browser context instead of launching again', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bot-browser-'));
    const logger = createLogger();
    const fakePage = { isClosed: () => false };
    const fakeContext = {
      pages: () => [fakePage],
      newPage: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const launchPersistentContext = vi.fn(async () => fakeContext);

    const manager = new BrowserManager({
      mode: 'launch',
      userDataDir,
      browserChannel: 'chrome',
      browserPlatform: 'x11',
      logger,
      launchPersistentContext,
    });

    await manager.launch();
    await manager.launch();

    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    await manager.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
});

describe('BrowserManager launch-x11 mode', () => {
  it('launches system Chrome with X11 ozone and does not use CDP', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bot-x11-'));
    const logger = createLogger();
    const fakePage = { isClosed: () => false };
    const fakeContext = {
      pages: () => [fakePage],
      newPage: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const launchPersistentContext = vi.fn(async () => fakeContext);
    const connectOverCDP = vi.fn();

    const manager = new BrowserManager({
      mode: 'launch-x11',
      userDataDir,
      headless: false,
      viewport: { width: 1280, height: 800 },
      browserChannel: 'chrome',
      browserExecutablePath: '/usr/bin/google-chrome-stable',
      browserPlatform: 'x11',
      logger,
      launchPersistentContext,
      connectOverCDP,
    });

    const page = await manager.start();

    expect(manager.isLaunchMode()).toBe(true);
    expect(manager.isExistingMode()).toBe(false);
    expect(page).toBe(fakePage);
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launchPersistentContext).toHaveBeenCalledWith(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: ['--ozone-platform=x11'],
      executablePath: '/usr/bin/google-chrome-stable',
    });

    await manager.close();
    expect(fakeContext.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(userDataDir)).toBe(true);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
});

describe('detectSystemBrowserExecutable', () => {
  it('returns the first existing candidate', () => {
    expect(
      detectSystemBrowserExecutable({
        configuredPath: '/missing/chrome',
        candidates: ['/missing/a', '/usr/bin/chromium', '/usr/bin/google-chrome-stable'],
        existsSyncFn: (candidate) => candidate === '/usr/bin/chromium',
      }),
    ).toBe('/usr/bin/chromium');
  });
});

describe('BrowserManager storage-state mode', () => {
  it('loads storage state into a headless browser without CDP or personal Chrome', async () => {
    const logger = createLogger();
    const fakePage = { isClosed: () => false };
    const fakeContext = {
      newPage: vi.fn(async () => fakePage),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const fakeBrowser = {
      newContext: vi.fn(async () => fakeContext),
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };
    const launch = vi.fn(async () => fakeBrowser);
    const connectOverCDP = vi.fn();
    const launchPersistentContext = vi.fn();
    const readStorageStateFileFn = vi.fn(async () => ({
      state: { cookies: [{ domain: '.instagram.com' }], origins: [] },
      summary: { cookieCount: 1, originCount: 0, hasInstagramState: true },
    }));

    const manager = new BrowserManager({
      mode: 'storage-state',
      headless: true,
      viewport: { width: 1280, height: 800 },
      browserExecutablePath: '/usr/bin/google-chrome-stable',
      authStorageStatePath: '/tmp/instagram-auth.json',
      logger,
      launch,
      connectOverCDP,
      launchPersistentContext,
      existsSyncFn: (candidate) => candidate === '/usr/bin/google-chrome-stable',
      readStorageStateFileFn,
    });

    const page = await manager.start();

    expect(page).toBe(fakePage);
    expect(manager.isStorageStateMode()).toBe(true);
    expect(manager.isExistingMode()).toBe(false);
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(readStorageStateFileFn).toHaveBeenCalledWith('/tmp/instagram-auth.json');
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/usr/bin/google-chrome-stable',
    });
    expect(fakeBrowser.newContext).toHaveBeenCalledWith({
      storageState: '/tmp/instagram-auth.json',
      viewport: { width: 1280, height: 800 },
    });

    await manager.close();
    expect(fakeContext.close).toHaveBeenCalled();
    expect(fakeBrowser.close).toHaveBeenCalled();
  });

  it('produces an actionable error when the storage state is missing or invalid', async () => {
    const manager = new BrowserManager({
      mode: 'storage-state',
      headless: true,
      authStorageStatePath: '/tmp/missing-instagram-auth.json',
      browserExecutablePath: '/usr/bin/google-chrome-stable',
      logger: createLogger(),
      launch: vi.fn(),
      connectOverCDP: vi.fn(),
      existsSyncFn: () => true,
      readStorageStateFileFn: vi.fn(async () => {
        throw new StorageStateError(
          'Auth storage state file is missing: /tmp/missing-instagram-auth.json. Generate a new state on your local machine with `npm run login`.',
          { code: 'MISSING_STORAGE_STATE' },
        );
      }),
    });

    await expect(manager.start()).rejects.toThrow(/npm run login/);
    await expect(manager.start()).rejects.toMatchObject({ code: 'MISSING_STORAGE_STATE' });
  });
});

