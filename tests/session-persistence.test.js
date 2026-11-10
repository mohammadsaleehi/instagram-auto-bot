import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthState } from '../src/auth/auth-state.js';
import { SessionPersistenceManager } from '../src/auth/session-persistence.js';
import { StorageStateError } from '../src/auth/storage-state.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('SessionPersistenceManager', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-persist-'));
    filePath = path.join(dir, 'instagram-auth.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses a five-minute persistence interval by default', () => {
    const manager = new SessionPersistenceManager({
      context: {},
      page: { isClosed: () => false },
      storageStatePath: filePath,
      logger: createLogger(),
    });

    expect(manager.intervalMs).toBe(300_000);
  });

  it('starts a timer with the configured interval and flushes on graceful stop', async () => {
    const logger = createLogger();
    const setIntervalFn = vi.fn((fn, ms) => ({ ms, fn, unref: vi.fn() }));
    const clearIntervalFn = vi.fn();
    const exportStorageStateFn = vi.fn(async () => ({
      cookieCount: 1,
      originCount: 1,
      hasInstagramState: true,
    }));
    const detectAuthStateFn = vi.fn(async () => ({
      state: AuthState.AUTHENTICATED,
      url: 'https://www.instagram.com/',
      signals: ['authenticated_nav_visible'],
      reason: 'ok',
    }));

    const manager = new SessionPersistenceManager({
      context: {},
      page: { isClosed: () => false },
      storageStatePath: filePath,
      intervalMs: 300_000,
      logger,
      setIntervalFn,
      clearIntervalFn,
      exportStorageStateFn,
      detectAuthStateFn,
    });

    manager.start();
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 300_000);

    const result = await manager.stop({ finalSave: true });
    expect(result.saved).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(exportStorageStateFn).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent saves so only one export runs at a time', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;

    const exportStorageStateFn = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { cookieCount: 1, originCount: 1, hasInstagramState: true };
    });

    const manager = new SessionPersistenceManager({
      context: {},
      page: { isClosed: () => false },
      storageStatePath: filePath,
      logger: createLogger(),
      exportStorageStateFn,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: [],
        reason: 'ok',
      })),
    });

    const first = manager.save();
    const second = manager.save();
    release();
    const results = await Promise.all([first, second]);

    expect(exportStorageStateFn).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(results.every((result) => result.saved)).toBe(true);
  });

  it('never overwrites a valid state when authentication is invalid', async () => {
    const exportStorageStateFn = vi.fn(async () => ({
      cookieCount: 1,
      originCount: 1,
      hasInstagramState: true,
    }));

    const manager = new SessionPersistenceManager({
      context: {},
      page: { isClosed: () => false },
      storageStatePath: filePath,
      logger: createLogger(),
      exportStorageStateFn,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.LOGIN_REQUIRED,
        url: 'https://www.instagram.com/accounts/login/',
        signals: ['login_form_visible'],
        reason: 'Login form is visible',
      })),
    });

    const result = await manager.save();
    expect(result.saved).toBe(false);
    expect(result.state).toBe(AuthState.LOGIN_REQUIRED);
    expect(exportStorageStateFn).not.toHaveBeenCalled();
  });

  it('handles export failures without crashing and preserves the previous file', async () => {
    fs.writeFileSync(filePath, JSON.stringify({ ok: true }));
    const logger = createLogger();

    const manager = new SessionPersistenceManager({
      context: {},
      page: { isClosed: () => false },
      storageStatePath: filePath,
      logger,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: [],
        reason: 'ok',
      })),
      exportStorageStateFn: vi.fn(async () => {
        throw new StorageStateError('boom', { code: 'EXPORT_STORAGE_STATE_FAILED' });
      }),
    });

    const result = await manager.save();
    expect(result.saved).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('"ok":true');
    expect(logger.error).toHaveBeenCalled();
  });
});
