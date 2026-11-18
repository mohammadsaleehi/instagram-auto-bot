import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  assessOverallHealth,
  classifyDoctorCheck,
  createTheme,
  doctorExitCode,
  formatDateTime,
  parseCliArgs,
  redactSensitive,
  renderControlError,
  renderDoctorReport,
  renderJobsReport,
  renderPauseResult,
  renderResumeResult,
  renderStatusDashboard,
  truncateId,
} from '../../src/cli/ui/index.js';

function createCapture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return {
    stream,
    get text() {
      return text;
    },
  };
}

function theme(options = {}) {
  const out = createCapture();
  const err = createCapture();
  return {
    theme: createTheme({
      stdout: /** @type {any} */ (out.stream),
      stderr: /** @type {any} */ (err.stream),
      columns: options.columns ?? 80,
      forceColor: options.forceColor ?? false,
      forceUnicode: options.forceUnicode ?? false,
      env: options.env ?? {},
    }),
    out,
    err,
  };
}

const healthyStatus = {
  applicationState: 'RUNNING',
  startedAt: '2026-11-10T16:14:08.000Z',
  browser: { connected: true, mode: 'existing' },
  authentication: {
    state: 'AUTHENTICATED',
    invalid: false,
    lastCheckedAt: new Date().toISOString(),
    recovery: null,
  },
  worker: {
    running: true,
    paused: false,
    queueSize: 0,
    currentTask: null,
    counts: {
      PENDING: 0,
      COMPLETED: 1,
      FAILED: 0,
      NEEDS_ATTENTION: 0,
    },
    lastSuccessful: {
      id: '3806eb0f-5f71-4437-96d6-9abec59442d2',
      type: 'engine.health-check',
      completedAt: '2026-11-10T16:14:24.000Z',
    },
  },
  queueSize: 0,
  runningTask: null,
  failedTaskCount: 0,
  needsAttentionCount: 0,
  lastSuccessfulTask: {
    id: '3806eb0f-5f71-4437-96d6-9abec59442d2',
    type: 'engine.health-check',
    completedAt: '2026-11-10T16:14:24.000Z',
  },
  lastSessionPersistence: null,
  database: { open: true, integrityOk: true },
  lastError: null,
};

describe('CLI args', () => {
  it('parses json, verbose and limit flags', () => {
    expect(parseCliArgs(['--json', '--verbose', '--limit', '20'])).toEqual({
      json: true,
      verbose: true,
      limit: 20,
      help: false,
      positionals: [],
    });
    expect(parseCliArgs(['50']).limit).toBe(50);
  });
});

describe('CLI formatting', () => {
  it('formats timestamps and truncates ids', () => {
    const formatted = formatDateTime('2026-11-10T16:14:24.000Z', {
      timezone: 'UTC',
      style: 'full',
    });
    expect(formatted).toContain('2026');
    expect(formatted).toContain('·');
    expect(truncateId('3806eb0f-5f71-4437-96d6-9abec59442d2')).toBe('3806eb0f');
  });

  it('redacts sensitive values', () => {
    expect(
      redactSensitive({ password: 'secret', ok: true, nested: { token: 'abc' } }),
    ).toEqual({
      password: '[REDACTED]',
      ok: true,
      nested: { token: '[REDACTED]' },
    });
  });
});

describe('status dashboard', () => {
  it('renders human-readable status without ANSI when color disabled', () => {
    const { theme: t } = theme({ forceColor: false });
    const output = renderStatusDashboard(healthyStatus, t, {
      timezone: 'UTC',
    });
    expect(output).toContain('INSTAGRAM AUTOMATION BOT');
    expect(output).toContain('RUNNING');
    expect(output).toContain('AUTHENTICATED');
    expect(output).toContain('HEALTHY');
    expect(output).not.toMatch(/\u001b\[/);
  });

  it('uses ANSI colors when enabled', () => {
    const { theme: t } = theme({ forceColor: true, forceUnicode: true });
    const output = renderStatusDashboard(healthyStatus, t);
    expect(output).toMatch(/\u001b\[/);
    expect(output).toContain('●');
  });

  it('respects NO_COLOR', () => {
    const { theme: t } = theme({
      forceColor: null,
      env: { NO_COLOR: '1', FORCE_COLOR: '1' },
    });
    // forceColor null + NO_COLOR => createTheme treats NO_COLOR first unless forceColor true
    const themed = createTheme({
      stdout: /** @type {any} */ ({ isTTY: true, columns: 80 }),
      stderr: /** @type {any} */ ({ isTTY: true }),
      env: { NO_COLOR: '1' },
      columns: 80,
    });
    expect(themed.colorEnabled).toBe(false);
    void t;
  });

  it('adapts to narrow terminals', () => {
    const { theme: t } = theme({ columns: 40, forceUnicode: false });
    const output = renderStatusDashboard(healthyStatus, t);
    expect(output.split('\n').every((line) => line.length <= 80)).toBe(true);
    expect(output).toContain('+');
  });

  it('marks system unhealthy when authentication is missing', () => {
    const status = {
      ...healthyStatus,
      authentication: {
        state: 'LOGIN_REQUIRED',
        invalid: true,
        lastCheckedAt: null,
        recovery: 'Run npm run login',
      },
    };
    const overall = assessOverallHealth(status);
    expect(overall.label).toBe('UNHEALTHY');
    expect(overall.tone).toBe('error');
    const { theme: t } = theme();
    const output = renderStatusDashboard(status, t);
    expect(output).toContain('UNHEALTHY');
    expect(output).toContain('Run npm run login');
  });

  it('marks disconnected browser as unhealthy', () => {
    const overall = assessOverallHealth({
      ...healthyStatus,
      browser: { connected: false, mode: 'existing' },
    });
    expect(overall.label).toBe('UNHEALTHY');
  });
});

describe('jobs report', () => {
  it('renders empty queue message', () => {
    const { theme: t } = theme();
    const output = renderJobsReport({ jobs: [] }, t);
    expect(output).toContain('No tasks found');
  });

  it('renders compact job rows and verbose details', () => {
    const { theme: t } = theme({ forceColor: true });
    const jobs = [
      {
        id: '3806eb0f-5f71-4437-96d6-9abec59442d2',
        type: 'engine.health-check',
        status: 'COMPLETED',
        priority: 100,
        createdAt: '2026-11-10T16:14:24.000Z',
        attemptCount: 1,
        maxAttempts: 3,
        resultMetadata: { ok: true },
      },
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        type: 'engine.health-check',
        status: 'FAILED',
        priority: 50,
        createdAt: '2026-11-10T16:20:00.000Z',
        attemptCount: 3,
        maxAttempts: 3,
        lastError: { errorClass: 'TIMEOUT', message: 'timed out' },
      },
    ];
    const output = renderJobsReport({ jobs }, t, {
      timezone: 'UTC',
      verbose: true,
    });
    expect(output).toContain('3806eb0f');
    expect(output).toContain('COMPLETED');
    expect(output).toContain('FAILED');
    expect(output).toContain('DETAILS');
    expect(output).toContain('TIMEOUT');
  });
});

describe('doctor report', () => {
  it('groups checks and reports exit codes', () => {
    const report = {
      ok: false,
      checks: [
        { name: 'config', ok: true, detail: { browserMode: 'existing' } },
        { name: 'database', ok: false, detail: 'corrupt' },
        {
          name: 'runtime',
          ok: true,
          detail: { running: false, note: 'offline' },
        },
        {
          name: 'control_socket_permissions',
          ok: true,
          detail: { present: true, secure: false, mode: '666' },
        },
      ],
    };
    expect(classifyDoctorCheck(report.checks[1])).toBe('fail');
    expect(classifyDoctorCheck(report.checks[2])).toBe('warn');
    expect(classifyDoctorCheck(report.checks[3])).toBe('warn');
    expect(doctorExitCode(report)).toBe(1);

    const { theme: t } = theme();
    const output = renderDoctorReport(report, t);
    expect(output).toContain('SYSTEM DIAGNOSTICS');
    expect(output).toContain('CHECKS FAILED');
    expect(output).toContain('Hint:');
    expect(output).not.toContain('password');
  });

  it('returns zero when only warnings exist', () => {
    expect(
      doctorExitCode({
        ok: true,
        checks: [
          {
            name: 'runtime',
            ok: true,
            detail: { running: false, note: 'offline' },
          },
        ],
      }),
    ).toBe(0);
  });
});

describe('pause / resume presentation', () => {
  it('distinguishes successful pause from already paused', () => {
    const { theme: t } = theme();
    expect(renderPauseResult({ paused: true, changed: true }, t)).toContain(
      'paused successfully',
    );
    expect(
      renderPauseResult({ paused: true, changed: false, alreadyPaused: true }, t),
    ).toContain('already paused');
  });

  it('renders resume rejection with recovery guidance', () => {
    const { theme: t } = theme();
    const output = renderResumeResult(
      {
        resumed: false,
        reason: 'Authentication is still invalid',
        recovery: 'Complete login in Chrome',
      },
      t,
    );
    expect(output).toContain('rejected');
    expect(output).toContain('Complete login in Chrome');
  });

  it('renders control errors for missing bot process', () => {
    const { theme: t } = theme();
    const output = renderControlError(
      { message: 'Bot control socket not found', code: 'BOT_NOT_RUNNING' },
      t,
    );
    expect(output).toContain('npm start');
    expect(output).toContain('Unable to reach the running bot');
  });
});
