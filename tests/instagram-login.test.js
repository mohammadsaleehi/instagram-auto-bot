import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthState } from '../src/auth/auth-state.js';
import { InstagramLogin, LoginError, getLoginSubmitLocator } from '../src/auth/instagram-login.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createLocator(overrides = {}) {
  return {
    first: vi.fn(function first() {
      return this;
    }),
    waitFor: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    isEnabled: vi.fn(async () => true),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    inputValue: vi.fn(async () => 'filled'),
    getAttribute: vi.fn(async () => null),
    or: vi.fn(function or() {
      return this;
    }),
    press: vi.fn(async () => {}),
    ...overrides,
  };
}

function createPage(options = {}) {
  const username = createLocator(options.username);
  const password = createLocator(options.password);
  const submit = createLocator(options.submit);
  const generic = createLocator();

  const page = {
    url: vi.fn(() => options.url ?? 'https://www.instagram.com/accounts/login/'),
    goto: vi.fn(async () => {}),
    waitForURL: vi.fn(async () => {}),
    locator: vi.fn((selector) => {
      if (String(selector).includes('name="email"') || String(selector).includes('name="username"')) {
        return username;
      }
      if (String(selector).includes('name="pass"') || String(selector).includes('name="password"') || String(selector).includes('type="password"')) {
        return password;
      }
      if (String(selector).includes('Log In') || String(selector).includes('type="submit"')) {
        return submit;
      }
      if (String(selector).includes('aria-label="Home"') || String(selector).includes('authenticated')) {
        return createLocator({ isVisible: vi.fn(async () => Boolean(options.authenticatedNav)) });
      }
      if (String(selector).includes('role="alert"') || String(selector).includes('login-error')) {
        return createLocator({ isVisible: vi.fn(async () => Boolean(options.loginError)) });
      }
      if (String(selector).includes('suspicious') || String(selector).includes('challenge')) {
        return createLocator({ isVisible: vi.fn(async () => Boolean(options.challenge)) });
      }
      if (String(selector).includes('login') || String(selector).includes('email') || String(selector).includes('username')) {
        return createLocator({
          isVisible: vi.fn(async () => Boolean(options.loginForm ?? true)),
        });
      }
      return generic;
    }),
    getByRole: vi.fn(() => submit),
  };

  return { page, username, password, submit };
}

describe('getLoginSubmitLocator', () => {
  it('prefers an accessible Log in role button', () => {
    const submit = createLocator();
    const page = {
      getByRole: vi.fn(() => submit),
      locator: vi.fn(() => createLocator()),
    };

    const locator = getLoginSubmitLocator(page);
    expect(page.getByRole).toHaveBeenCalled();
    expect(locator).toBe(submit);
  });
});

describe('InstagramLogin automatic login', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not attempt login when already authenticated', async () => {
    const { page, username, password, submit } = createPage({
      url: 'https://www.instagram.com/',
      authenticatedNav: true,
      loginForm: false,
    });

    // Force detectAuthState path via authenticated nav visibility.
    page.locator = vi.fn((selector) => {
      if (String(selector).includes('Home') || String(selector).includes('Search')) {
        return createLocator({ isVisible: vi.fn(async () => true) });
      }
      return createLocator({ isVisible: vi.fn(async () => false) });
    });

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 1000,
      navigationTimeoutMs: 1000,
      autoLogin: true,
      username: 'demo',
      password: 'secret',
      logger: createLogger(),
    });

    const result = await login.ensureAuthenticated();
    expect(result.state).toBe(AuthState.AUTHENTICATED);
    expect(username.fill).not.toHaveBeenCalled();
    expect(password.fill).not.toHaveBeenCalled();
    expect(submit.click).not.toHaveBeenCalled();
    expect(login._formSubmitted).toBe(false);
  });

  it('falls back to manual login when credentials are missing', async () => {
    const { page } = createPage({ loginForm: true });
    page.locator = vi.fn((selector) => {
      if (String(selector).includes('email') || String(selector).includes('username') || String(selector).includes('login')) {
        return createLocator({ isVisible: vi.fn(async () => true) });
      }
      return createLocator({ isVisible: vi.fn(async () => false) });
    });

    const logger = createLogger();
    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 50,
      navigationTimeoutMs: 1000,
      autoLogin: true,
      username: null,
      password: null,
      logger,
    });

    await expect(login.ensureAuthenticated()).rejects.toBeInstanceOf(LoginError);
    expect(logger.info).toHaveBeenCalledWith(
      'Manual login',
      expect.objectContaining({ hasCredentials: false }),
    );
    expect(login._formSubmitted).toBe(false);
  });

  it('fills credentials and submits once when auto-login is enabled', async () => {
    const { page, username, password, submit } = createPage({ loginForm: true });
    let submitted = false;

    username.isVisible = vi.fn(async () => !submitted);
    password.isVisible = vi.fn(async () => !submitted);
    submit.click = vi.fn(async () => {
      submitted = true;
      page.url = vi.fn(() => 'https://www.instagram.com/');
    });

    page.locator = vi.fn((selector) => {
      const sel = String(selector);
      if (sel.includes('name="email"') || sel.includes('name="username"') || sel.includes('autocomplete')) {
        return username;
      }
      if (sel.includes('name="pass"') || sel.includes('name="password"') || sel.includes('type="password"')) {
        return password;
      }
      if (sel.includes('Log In') || sel.includes('type="submit"')) {
        return submit;
      }
      if (sel.includes('Home') || sel.includes('Search') || sel.includes('Explore') || sel.includes('Messages')) {
        return createLocator({
          isVisible: vi.fn(async () => submitted),
          waitFor: vi.fn(async () => {
            if (!submitted) {
              throw new Error('not authenticated yet');
            }
          }),
        });
      }
      if (sel.includes('login_form') || sel.includes('loginForm') || sel.includes('id*="login"')) {
        return createLocator({
          isVisible: vi.fn(async () => !submitted),
        });
      }
      return createLocator({ isVisible: vi.fn(async () => false) });
    });
    page.getByRole = vi.fn(() => submit);

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 2000,
      navigationTimeoutMs: 1000,
      autoLogin: true,
      username: 'demo_user',
      password: 'demo_pass',
      logger: createLogger(),
    });

    const result = await login.ensureAuthenticated();
    expect(username.fill).toHaveBeenCalledTimes(1);
    expect(password.fill).toHaveBeenCalledTimes(1);
    expect(submit.click).toHaveBeenCalledTimes(1);
    expect(login._formSubmitted).toBe(true);
    expect(result.state).toBe(AuthState.AUTHENTICATED);

    // Second call to performAutoLogin must not resubmit.
    await login.performAutoLogin();
    expect(submit.click).toHaveBeenCalledTimes(1);
  });

  it('throws an actionable error when the submit button is unavailable', async () => {
    const username = createLocator({ inputValue: vi.fn(async () => 'demo') });
    const password = createLocator({ inputValue: vi.fn(async () => 'secret') });
    const submit = createLocator({
      waitFor: vi.fn(async () => {
        throw new Error('timeout');
      }),
      isVisible: vi.fn(async () => false),
    });

    const page = {
      url: vi.fn(() => 'https://www.instagram.com/accounts/login/'),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}),
      getByRole: vi.fn(() => submit),
      locator: vi.fn((selector) => {
        const sel = String(selector);
        if (sel.includes('email') || sel.includes('username')) return username;
        if (sel.includes('pass') || sel.includes('password')) return password;
        if (sel.includes('login')) return createLocator({ isVisible: vi.fn(async () => true) });
        return createLocator({ isVisible: vi.fn(async () => false) });
      }),
    };

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 1000,
      navigationTimeoutMs: 100,
      autoLogin: true,
      username: 'demo',
      password: 'secret',
      logger: createLogger(),
    });

    await expect(login.performAutoLogin()).rejects.toMatchObject({
      code: 'SUBMIT_BUTTON_NOT_FOUND',
    });
    expect(submit.click).not.toHaveBeenCalled();
  });

  it('reports invalid credentials safely after a single submit', async () => {
    const username = createLocator({ inputValue: vi.fn(async () => 'demo') });
    const password = createLocator({ inputValue: vi.fn(async () => 'bad') });
    const submit = createLocator();
    let phase = 0;

    const page = {
      url: vi.fn(() => 'https://www.instagram.com/accounts/login/'),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}),
      getByRole: vi.fn(() => submit),
      locator: vi.fn((selector) => {
        const sel = String(selector);
        if (sel.includes('email') || sel.includes('username') || sel.includes('autocomplete')) {
          return username;
        }
        if (sel.includes('pass') || sel.includes('password')) {
          return password;
        }
        if (sel.includes('Log In') || sel.includes('type="submit"')) {
          return submit;
        }
        if (sel.includes('alert') || sel.includes('error')) {
          return createLocator({
            isVisible: vi.fn(async () => phase > 0),
            waitFor: vi.fn(async () => {
              phase = 1;
            }),
          });
        }
        if (sel.includes('login') || sel.includes('email')) {
          return createLocator({ isVisible: vi.fn(async () => true) });
        }
        return createLocator({ isVisible: vi.fn(async () => false) });
      }),
    };

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 1500,
      navigationTimeoutMs: 500,
      autoLogin: true,
      username: 'demo',
      password: 'bad',
      logger: createLogger(),
    });

    await expect(login.ensureAuthenticated()).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(submit.click).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for manual verification without resubmitting', async () => {
    const page = {
      url: vi.fn(() => 'https://www.instagram.com/challenge/abc/'),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}),
      getByRole: vi.fn(() => createLocator()),
      locator: vi.fn((selector) => {
        const sel = String(selector);
        if (sel.includes('suspicious') || sel.includes('challenge') || sel.includes('verify')) {
          return createLocator({
            isVisible: vi.fn(async () => true),
            waitFor: vi.fn(async () => {}),
          });
        }
        return createLocator({ isVisible: vi.fn(async () => false) });
      }),
    };

    const logger = createLogger();
    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 100,
      navigationTimeoutMs: 100,
      autoLogin: true,
      username: 'demo',
      password: 'secret',
      logger,
    });

    await expect(login.ensureAuthenticated()).rejects.toMatchObject({
      code: 'VERIFICATION_TIMEOUT',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Verification required',
      expect.objectContaining({
        hint: expect.stringMatching(/2FA|checkpoint|CAPTCHA/i),
      }),
    );
    expect(login._formSubmitted).toBe(false);
  });

  it('does not auto-login when AUTO_LOGIN is disabled even if credentials exist', async () => {
    const { page, username, password, submit } = createPage({ loginForm: true });
    page.locator = vi.fn((selector) => {
      const sel = String(selector);
      if (sel.includes('email') || sel.includes('username') || sel.includes('login')) {
        return createLocator({ isVisible: vi.fn(async () => true) });
      }
      return createLocator({ isVisible: vi.fn(async () => false) });
    });

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 50,
      navigationTimeoutMs: 100,
      autoLogin: false,
      username: 'demo',
      password: 'secret',
      logger: createLogger(),
    });

    await expect(login.ensureAuthenticated()).rejects.toBeInstanceOf(LoginError);
    expect(username.fill).not.toHaveBeenCalled();
    expect(password.fill).not.toHaveBeenCalled();
    expect(submit.click).not.toHaveBeenCalled();
  });
});
