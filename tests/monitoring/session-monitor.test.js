import { describe, expect, it, vi } from 'vitest';
import { AuthState } from '../../src/auth/auth-state.js';
import {
  SessionMonitor,
  recoveryInstructions,
} from '../../src/monitoring/session-monitor.js';
import { EventBus } from '../../src/core/event-bus.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('SessionMonitor', () => {
  it('marks session invalid and emits recovery guidance', async () => {
    const eventsBus = new EventBus();
    const invalidEvents = [];
    eventsBus.on('auth.invalid', (payload) => invalidEvents.push(payload));

    const monitor = new SessionMonitor({
      instagram: {
        browser: {
          getPage: () => ({}),
        },
      },
      logger: createLogger(),
      eventsBus,
      detectAuthStateFn: async () => ({
        state: AuthState.LOGIN_REQUIRED,
        url: 'https://www.instagram.com/accounts/login/',
        signals: [],
        reason: 'Login form is visible',
      }),
    });

    const result = await monitor.check();
    expect(result.state).toBe(AuthState.LOGIN_REQUIRED);
    expect(monitor.isInvalid()).toBe(true);
    expect(invalidEvents).toHaveLength(1);
    expect(recoveryInstructions(AuthState.LOGIN_REQUIRED)).toMatch(/npm run login/);
  });

  it('clears invalid flag when authentication returns', async () => {
    let state = AuthState.LOGIN_REQUIRED;
    const monitor = new SessionMonitor({
      instagram: { browser: { getPage: () => ({}) } },
      logger: createLogger(),
      detectAuthStateFn: async () => ({
        state,
        url: 'https://www.instagram.com/',
        signals: [],
        reason: 'x',
      }),
    });

    await monitor.check();
    expect(monitor.isInvalid()).toBe(true);
    state = AuthState.AUTHENTICATED;
    await monitor.check();
    expect(monitor.isInvalid()).toBe(false);
  });
});
