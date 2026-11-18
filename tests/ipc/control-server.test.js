import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlServer } from '../../src/ipc/control-server.js';
import { createControlClient } from '../../src/ipc/control-client.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('ControlServer / ControlClient', () => {
  /** @type {ControlServer[]} */
  const servers = [];
  /** @type {string[]} */
  const dirs = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves authenticated local control requests over a user-only socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ipc-'));
    dirs.push(dir);
    const socketPath = path.join(dir, 'bot.sock');
    const tokenPath = path.join(dir, 'bot.control-token');

    const server = new ControlServer({
      socketPath,
      tokenPath,
      logger: createLogger(),
      handlers: {
        status: () => ({ applicationState: 'RUNNING' }),
        pause: () => ({ paused: true }),
        resume: () => ({ resumed: true }),
        jobs: () => ({ jobs: [{ id: '1', status: 'COMPLETED' }] }),
        doctor: () => ({ ok: true, checks: [] }),
      },
    });
    servers.push(server);
    await server.start();

    const mode = fs.statSync(socketPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);

    const client = createControlClient({ socketPath, tokenPath });
    await expect(client.status()).resolves.toEqual({ applicationState: 'RUNNING' });
    await expect(client.pause()).resolves.toEqual({ paused: true });
    await expect(client.resume()).resolves.toEqual({ resumed: true });
    await expect(client.jobs()).resolves.toEqual({
      jobs: [{ id: '1', status: 'COMPLETED' }],
    });
    await expect(client.doctor()).resolves.toEqual({ ok: true, checks: [] });
  });

  it('rejects missing socket with actionable guidance', async () => {
    const client = createControlClient({
      socketPath: path.join(os.tmpdir(), 'missing-bot.sock'),
      tokenPath: path.join(os.tmpdir(), 'missing-bot.token'),
    });
    await expect(client.status()).rejects.toMatchObject({
      code: 'BOT_NOT_RUNNING',
    });
  });
});
