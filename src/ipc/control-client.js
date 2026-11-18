import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONTROL_SOCKET_PATH,
  DEFAULT_CONTROL_TOKEN_PATH,
} from './control-server.js';

export class ControlClientError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ControlClientError';
    this.code = options.code ?? 'CONTROL_CLIENT_ERROR';
  }
}

/**
 * @param {{
 *   socketPath?: string,
 *   tokenPath?: string,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createControlClient(options = {}) {
  const socketPath = options.socketPath ?? DEFAULT_CONTROL_SOCKET_PATH;
  const tokenPath = options.tokenPath ?? DEFAULT_CONTROL_TOKEN_PATH;
  const timeoutMs = options.timeoutMs ?? 5_000;

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  async function request(method, params = {}) {
    if (!fs.existsSync(socketPath)) {
      throw new ControlClientError(
        `Bot control socket not found at ${socketPath}. Is the bot running? Start it with: npm start`,
        { code: 'BOT_NOT_RUNNING' },
      );
    }

    if (!fs.existsSync(tokenPath)) {
      throw new ControlClientError(
        `Control token missing at ${tokenPath}. The bot may have stopped uncleanly. Restart with: npm start`,
        { code: 'TOKEN_MISSING' },
      );
    }

    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token) {
      throw new ControlClientError('Control token file is empty', {
        code: 'TOKEN_EMPTY',
      });
    }

    // Permission check: socket should not be world-accessible.
    try {
      const stat = fs.statSync(socketPath);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        throw new ControlClientError(
          `Refusing to use world/group-accessible control socket (mode ${mode.toString(8)})`,
          { code: 'INSECURE_SOCKET' },
        );
      }
    } catch (error) {
      if (error instanceof ControlClientError) {
        throw error;
      }
      // Some platforms may not support mode checks the same way.
    }

    const id = randomUUID();
    const payload = `${JSON.stringify({ id, method, params, token })}\n`;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        fail(
          new ControlClientError('Control request timed out', {
            code: 'TIMEOUT',
          }),
        );
      }, timeoutMs);

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      const succeed = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(value);
      };

      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(payload);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          return;
        }
        const line = buffer.slice(0, newline).trim();
        try {
          const message = JSON.parse(line);
          if (!message.ok) {
            fail(
              new ControlClientError(
                message.error?.message ?? 'Control request failed',
                { code: message.error?.code ?? 'CONTROL_ERROR' },
              ),
            );
            return;
          }
          succeed(message.result);
        } catch (error) {
          fail(
            new ControlClientError('Invalid control response', {
              code: 'INVALID_RESPONSE',
              cause: error,
            }),
          );
        }
      });
      socket.on('error', (error) => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          fail(
            new ControlClientError(
              `Bot is not running (could not connect to ${socketPath}). Start it with: npm start`,
              { code: 'BOT_NOT_RUNNING', cause: error },
            ),
          );
          return;
        }
        fail(
          new ControlClientError(error.message, {
            code: 'SOCKET_ERROR',
            cause: error,
          }),
        );
      });
    });
  }

  return {
    request,
    status: () => request('status'),
    pause: () => request('pause'),
    resume: () => request('resume'),
    jobs: (params) => request('jobs', params),
    doctor: () => request('doctor'),
  };
}
