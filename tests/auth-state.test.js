import { describe, expect, it } from 'vitest';
import { AuthState, classifyAuthState } from '../src/auth/auth-state.js';

describe('classifyAuthState', () => {
  it('detects AUTHENTICATED from authenticated navigation without a login form', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/',
      hasLoginForm: false,
      hasAuthenticatedNav: true,
    });

    expect(result.state).toBe(AuthState.AUTHENTICATED);
    expect(result.signals).toContain('authenticated_nav_visible');
  });

  it('detects LOGIN_REQUIRED when the login form is visible', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/accounts/login/',
      hasLoginForm: true,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.LOGIN_REQUIRED);
    expect(result.signals).toContain('login_form_visible');
    expect(result.signals).toContain('logged_out_url');
  });

  it('detects LOGIN_REQUIRED from logged-out URL hints alone', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/accounts/login/?source=auth_switcher',
      hasLoginForm: false,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.LOGIN_REQUIRED);
  });

  it('detects LOGIN_REQUIRED with login error signal', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/accounts/login/',
      hasLoginForm: true,
      hasLoginError: true,
    });

    expect(result.state).toBe(AuthState.LOGIN_REQUIRED);
    expect(result.signals).toContain('login_error_visible');
    expect(result.reason).toMatch(/login error/i);
  });

  it('detects VERIFICATION_REQUIRED from challenge URL paths', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/challenge/123/abc/',
      hasLoginForm: false,
      hasAuthenticatedNav: false,
      hasChallengeIndicators: false,
    });

    expect(result.state).toBe(AuthState.VERIFICATION_REQUIRED);
    expect(result.signals).toContain('verification_url');
  });

  it('detects VERIFICATION_REQUIRED from challenge page text indicators', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/',
      hasChallengeIndicators: true,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.VERIFICATION_REQUIRED);
  });

  it('detects VERIFICATION_REQUIRED for two-factor URL paths', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/accounts/login/two_factor?next=%2F',
      hasChallengeIndicators: false,
    });

    expect(result.state).toBe(AuthState.VERIFICATION_REQUIRED);
  });

  it('returns NOT_AUTHENTICATED for Instagram root without signals', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/',
      hasLoginForm: false,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.NOT_AUTHENTICATED);
  });

  it('returns UNKNOWN when no conclusive signals exist on an arbitrary page', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/explore/tags/coffee/',
      hasLoginForm: false,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.UNKNOWN);
    expect(result.reason).toMatch(/no conclusive/i);
  });

  it('returns UNKNOWN when authenticated and login signals conflict', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/',
      hasLoginForm: true,
      hasAuthenticatedNav: true,
    });

    expect(result.state).toBe(AuthState.UNKNOWN);
    expect(result.reason).toMatch(/conflicting/i);
  });

  it('does not treat URL alone as proof of authentication', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/',
      hasLoginForm: false,
      hasAuthenticatedNav: false,
    });

    expect(result.state).not.toBe(AuthState.AUTHENTICATED);
  });

  it('prefers verification over login when challenge indicators are present with a form', () => {
    const result = classifyAuthState({
      url: 'https://www.instagram.com/challenge/',
      hasLoginForm: true,
      hasChallengeIndicators: true,
      hasAuthenticatedNav: false,
    });

    expect(result.state).toBe(AuthState.VERIFICATION_REQUIRED);
  });
});
