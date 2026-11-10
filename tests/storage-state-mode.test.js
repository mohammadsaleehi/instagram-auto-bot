import { describe, expect, it, vi } from 'vitest';
import { AuthState } from '../src/auth/auth-state.js';
import { ensureStorageStateAuthenticated } from '../src/auth/storage-state-auth.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('ensureStorageStateAuthenticated', () => {
  it('continues only when the loaded storage state is authenticated', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => 'https://www.instagram.com/'),
    };

    const result = await ensureStorageStateAuthenticated(page, {
      baseUrl: 'https://www.instagram.com',
      navigationTimeoutMs: 1000,
      logger: createLogger(),
      storageStatePath: './data/instagram-auth.json',
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: ['authenticated_nav_visible'],
        reason: 'ok',
      })),
    });

    expect(result.state).toBe(AuthState.AUTHENTICATED);
    expect(page.goto).toHaveBeenCalled();
  });

  it('stops with an actionable error for invalid/expired storage state', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => 'https://www.instagram.com/accounts/login/'),
    };

    await expect(
      ensureStorageStateAuthenticated(page, {
        baseUrl: 'https://www.instagram.com',
        navigationTimeoutMs: 1000,
        logger: createLogger(),
        storageStatePath: './data/instagram-auth.json',
        detectAuthStateFn: vi.fn(async () => ({
          state: AuthState.LOGIN_REQUIRED,
          url: 'https://www.instagram.com/accounts/login/',
          signals: ['login_form_visible'],
          reason: 'Login form is visible',
        })),
      }),
    ).rejects.toMatchObject({
      name: 'LoginError',
      code: 'STORAGE_STATE_AUTH_INVALID',
    });
  });
});
