import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exportContextStorageState,
  filterInstagramStorageState,
  isValidStorageStateFile,
  readStorageStateFile,
  sessionInvalidationMessage,
  StorageStateError,
  validateStorageState,
  verifyExportedStorageStateFile,
  writeStorageStateAtomic,
} from '../src/auth/storage-state.js';

function sampleState(overrides = {}) {
  return {
    cookies: [
      {
        name: 'sessionid',
        value: 'secret-session-value',
        domain: '.instagram.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ],
    origins: [
      {
        origin: 'https://www.instagram.com',
        localStorage: [{ name: 'ig-test', value: '1' }],
        indexedDB: [
          {
            name: 'instagram-test-db',
            version: 1,
            stores: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('validateStorageState', () => {
  it('accepts Instagram-origin cookies and origins', () => {
    const summary = validateStorageState(sampleState());
    expect(summary.hasInstagramState).toBe(true);
    expect(summary.cookieCount).toBe(1);
    expect(summary.originCount).toBe(1);
  });

  it('rejects empty or non-Instagram snapshots', () => {
    expect(() => validateStorageState(null)).toThrow(StorageStateError);
    expect(() => validateStorageState({ cookies: [] })).toThrow(/no usable Instagram/);
    expect(() =>
      validateStorageState({
        cookies: [{ name: 'a', value: 'b', domain: '.example.com' }],
        origins: [],
      }),
    ).toThrow(/no usable Instagram/);
  });
});

describe('filterInstagramStorageState', () => {
  it('keeps only Instagram cookies and origins and drops unrelated personal sessions', () => {
    const filtered = filterInstagramStorageState({
      cookies: [
        { name: 'sessionid', value: 'ig-secret', domain: '.instagram.com', path: '/' },
        { name: 'SID', value: 'google-secret', domain: '.google.com', path: '/' },
        { name: 'user_session', value: 'github-secret', domain: '.github.com', path: '/' },
        { name: 'cf_clearance', value: 'chatgpt-secret', domain: 'chatgpt.com', path: '/' },
        { name: 'csrftoken', value: 'ig-csrf', domain: 'www.instagram.com', path: '/' },
      ],
      origins: [
        {
          origin: 'https://www.instagram.com',
          localStorage: [{ name: 'ig', value: '1' }],
          indexedDB: [{ name: 'instagram-test-db', version: 1, stores: [] }],
        },
        { origin: 'https://accounts.google.com', localStorage: [{ name: 'g', value: '1' }] },
        { origin: 'https://github.com', localStorage: [{ name: 'gh', value: '1' }] },
        { origin: 'https://chatgpt.com', localStorage: [{ name: 'c', value: '1' }] },
      ],
    });

    expect(filtered.cookies.map((cookie) => cookie.domain)).toEqual([
      '.instagram.com',
      'www.instagram.com',
    ]);
    expect(filtered.origins.map((origin) => origin.origin)).toEqual([
      'https://www.instagram.com',
    ]);
    expect(filtered.removedCookieCount).toBe(3);
    expect(filtered.removedOriginCount).toBe(3);
    expect(JSON.stringify(filtered)).not.toContain('google-secret');
    expect(JSON.stringify(filtered)).not.toContain('github-secret');
    expect(JSON.stringify(filtered)).not.toContain('chatgpt-secret');
  });
});

describe('atomic storage-state writes', () => {
  /** @type {string} */
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-auth-state-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically with 0600 permissions and preserves the previous valid file on failure', async () => {
    const filePath = path.join(dir, 'instagram-auth.json');
    await writeStorageStateAtomic(filePath, sampleState());

    const stats = fs.statSync(filePath);
    expect(stats.mode & 0o777).toBe(0o600);

    const before = fs.readFileSync(filePath, 'utf8');
    await expect(
      writeStorageStateAtomic(filePath, {
        cookies: [{ name: 'x', value: 'y', domain: '.unrelated.test' }],
        origins: [],
      }),
    ).rejects.toBeInstanceOf(StorageStateError);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('exports IndexedDB via context.storageState, filters non-Instagram data, and validates before rename', async () => {
    const filePath = path.join(dir, 'instagram-auth.json');
    const mixedState = {
      cookies: [
        ...sampleState().cookies,
        { name: 'SID', value: 'google-secret', domain: '.google.com', path: '/' },
      ],
      origins: [
        ...sampleState().origins,
        { origin: 'https://github.com', localStorage: [{ name: 'token', value: 'leak' }] },
      ],
    };
    const storageState = vi.fn(async ({ path: tmpPath, indexedDB }) => {
      expect(indexedDB).toBe(true);
      expect(tmpPath).toMatch(/\.tmp$/);
      await fs.promises.writeFile(tmpPath, JSON.stringify(mixedState), { mode: 0o600 });
      return mixedState;
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const summary = await exportContextStorageState(
      { storageState },
      filePath,
      { storageState, logger },
    );

    expect(summary.hasInstagramState).toBe(true);
    expect(summary.removedCookieCount).toBe(1);
    expect(summary.removedOriginCount).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.mode).toBe(0o600);
    expect(storageState).toHaveBeenCalledWith({ path: expect.any(String), indexedDB: true });
    expect(await isValidStorageStateFile(filePath)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('Auth storage-state export started', expect.any(Object));
    expect(logger.info).toHaveBeenCalledWith('Instagram cookies collected', expect.any(Object));
    expect(logger.info).toHaveBeenCalledWith('Final auth storage-state file verified', expect.any(Object));

    const verified = await verifyExportedStorageStateFile(filePath);
    expect(verified.bytes).toBeGreaterThan(0);
    expect(verified.mode).toBe(0o600);

    const loaded = await readStorageStateFile(filePath);
    expect(loaded.state.origins[0].indexedDB?.[0]?.name).toBe('instagram-test-db');
    expect(JSON.stringify(loaded.state)).not.toContain('google-secret');
    expect(JSON.stringify(loaded.state)).not.toContain('github.com');
  });

  it('rejects empty Instagram state and reports filesystem verification failures', async () => {
    const filePath = path.join(dir, 'instagram-auth.json');
    const storageState = vi.fn(async ({ path: tmpPath }) => {
      const empty = { cookies: [], origins: [] };
      await fs.promises.writeFile(tmpPath, JSON.stringify(empty));
      return empty;
    });

    await expect(
      exportContextStorageState({ storageState }, filePath, { storageState }),
    ).rejects.toBeInstanceOf(StorageStateError);

    expect(fs.existsSync(filePath)).toBe(false);
    await expect(verifyExportedStorageStateFile(filePath)).rejects.toMatchObject({
      code: 'EXPORT_VERIFY_MISSING',
    });
  });
});

describe('missing/invalid storage state errors', () => {
  it('produces actionable guidance for a missing file', async () => {
    await expect(
      readStorageStateFile(path.join(os.tmpdir(), `missing-ig-auth-${Date.now()}.json`)),
    ).rejects.toThrow(/npm run login/);
  });

  it('explains recovery in sessionInvalidationMessage', () => {
    const message = sessionInvalidationMessage('LOGIN_REQUIRED', './data/instagram-auth.json');
    expect(message).toMatch(/npm run login/);
    expect(message).toMatch(/scp/i);
  });
});
