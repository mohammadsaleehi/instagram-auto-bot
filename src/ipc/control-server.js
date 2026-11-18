import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  CONTROL_METHODS,
  errorResponse,
  parseRequest,
  successResponse,
} from './control-protocol.js';

export const DEFAULT_CONTROL_SOCKET_PATH = './data/bot.sock';
export const DEFAULT_CONTROL_TOKEN_PATH = './data/bot.control-token';

/**
 * Local Unix-domain control server. Not exposed to the network.
 */
export class ControlServer {
  /**
   * @param {{
   *   socketPath: string,
   *   tokenPath?: string,
   *   logger: { info: Function, warn: Function, error: Function, debug: Function },
   *   handlers: {
   *     status: () => unknown | Promise<unknown>,
   *     pause: () => unknown | Promise<unknown>,
   *     resume: () => unknown | Promise<unknown>,
   *     jobs: (params?: Record<string, unknown>) => unknown | Promise<unknown>,
   *     doctor: () => unknown | Promise<unknown>,
   *   },
   * }} options
   */
  constructor(options) {
    this.socketPath = options.socketPath;
    this.tokenPath = options.tokenPath ?? DEFAULT_CONTROL_TOKEN_PATH;
    this.logger = options.logger;
    this.handlers = options.handlers;
    /** @type {net.Server | null} */
    this._server = null;
    /** @type {string | null} */
    this._token = null;
  }

  /**
   * @returns {Promise<void>}
   */
  async start() {
    if (this._server) {
      return;
    }

    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this._removeStaleSocket();

    this._token = randomBytes(32).toString('hex');
    fs.writeFileSync(this.tokenPath, this._token, { mode: 0o600 });
    try {
      fs.chmodSync(this.tokenPath, 0o600);
    } catch {
      // best-effort
    }

    this._server = net.createServer((socket) => {
      this._handleConnection(socket);
    });

    await new Promise((resolve, reject) => {
      this._server?.once('error', reject);
      this._server?.listen(this.socketPath, () => {
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          // best-effort
        }
        this.logger.info('Control socket listening', {
          socketPath: this.socketPath,
        });
        resolve(undefined);
      });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    const server = this._server;
    this._server = null;
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
      });
    }
    this._removeStaleSocket();
    this._removeToken();
  }

  /**
   * @returns {void}
   */
  _removeStaleSocket() {
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch (error) {
      this.logger.warn('Failed to remove control socket', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @returns {void}
   */
  _removeToken() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
      }
    } catch {
      // ignore
    }
    this._token = null;
  }

  /**
   * @param {net.Socket} socket
   */
  _handleConnection(socket) {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) {
          continue;
        }
        void this._handleLine(socket, line);
      }
    });

    socket.on('error', () => {
      // ignore broken client pipes
    });
  }

  /**
   * @param {net.Socket} socket
   * @param {string} line
   */
  async _handleLine(socket, line) {
    let requestId = 'unknown';
    try {
      const message = JSON.parse(line);
      const token = message?.token;
      if (!this._token || token !== this._token) {
        socket.write(`${JSON.stringify(errorResponse(requestId, 'Unauthorized', 'UNAUTHORIZED'))}\n`);
        socket.end();
        return;
      }

      const request = parseRequest(message);
      requestId = request.id;
      const result = await this._dispatch(request.method, request.params);
      socket.write(`${JSON.stringify(successResponse(request.id, result))}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify(
          errorResponse(
            requestId,
            error instanceof Error ? error.message : String(error),
          ),
        )}\n`,
      );
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  async _dispatch(method, params = {}) {
    switch (method) {
      case CONTROL_METHODS.PING:
        return { pong: true };
      case CONTROL_METHODS.STATUS:
        return this.handlers.status();
      case CONTROL_METHODS.PAUSE:
        return this.handlers.pause();
      case CONTROL_METHODS.RESUME:
        return this.handlers.resume();
      case CONTROL_METHODS.JOBS:
        return this.handlers.jobs(params);
      case CONTROL_METHODS.DOCTOR:
        return this.handlers.doctor();
      default:
        throw new Error(`Unknown control method: ${method}`);
    }
  }
}
