/**
 * Shared graceful-shutdown helpers for Ctrl+C / SIGTERM.
 *
 * Root cause addressed: registering process SIGINT listeners disables Node's
 * default exit behavior. Handlers must cancel pending waits (readline, polls)
 * and allow the process to finish; a second signal force-exits without killing
 * the user's personal Chrome.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class ShutdownError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ShutdownError';
    this.code = options.code ?? 'SHUTDOWN';
  }
}

/**
 * Create an AbortController that is aborted when SIGINT/SIGTERM arrive.
 * Idempotent cleanup; second signal force-exits the Node process.
 *
 * @param {{
 *   logger?: {
 *     info?: (message: string, meta?: Record<string, unknown>) => void,
 *     warn?: (message: string, meta?: Record<string, unknown>) => void,
 *     error?: (message: string, meta?: Record<string, unknown>) => void,
 *   },
 *   signals?: NodeJS.Signals[],
 *   shutdownTimeoutMs?: number,
 *   onShutdown?: (signal: string) => void | Promise<void>,
 *   forceExitFn?: (code?: number) => void,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [options]
 */
export function createShutdownController(options = {}) {
  const logger = options.logger ?? console;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const forceExitFn = options.forceExitFn ?? ((code = 130) => process.exit(code));
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const controller = new AbortController();
  /** @type {Set<() => void>} */
  const cancelCallbacks = new Set();
  let shuttingDown = false;
  let forceRequested = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let forceTimer = null;
  /** @type {string | null} */
  let lastSignal = null;

  const runCancelCallbacks = () => {
    for (const callback of [...cancelCallbacks]) {
      try {
        callback();
      } catch {
        // Best-effort cancellation only.
      }
    }
  };

  /**
   * @param {() => void} callback
   * @returns {() => void}
   */
  const onCancel = (callback) => {
    cancelCallbacks.add(callback);
    return () => cancelCallbacks.delete(callback);
  };

  /**
   * @param {string} signal
   */
  const requestShutdown = (signal) => {
    lastSignal = signal;

    if (shuttingDown) {
      forceRequested = true;
      logger.warn?.('Second shutdown signal received; forcing Node.js exit', { signal });
      runCancelCallbacks();
      if (forceTimer) {
        clearTimeoutFn(forceTimer);
        forceTimer = null;
      }
      forceExitFn(130);
      return;
    }

    shuttingDown = true;
    logger.info?.('Shutdown requested', { signal });

    if (!controller.signal.aborted) {
      controller.abort(new ShutdownError(`Shutdown requested via ${signal}`, {
        code: 'SHUTDOWN_REQUESTED',
      }));
    }

    runCancelCallbacks();

    if (typeof options.onShutdown === 'function') {
      void Promise.resolve(options.onShutdown(signal)).catch((error) => {
        logger.error?.('Shutdown callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Keep the force-exit timer referenced so a stuck CDP/native wait cannot
    // prevent the second-chance timeout from firing.
    forceTimer = setTimeoutFn(() => {
      logger.warn?.('Graceful shutdown timed out; forcing Node.js exit', {
        signal,
        shutdownTimeoutMs,
      });
      forceExitFn(130);
    }, shutdownTimeoutMs);
  };

  /** @type {Map<NodeJS.Signals, () => void>} */
  const signalHandlers = new Map();

  for (const signal of signals) {
    const handler = () => {
      requestShutdown(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const dispose = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
    if (forceTimer) {
      clearTimeoutFn(forceTimer);
      forceTimer = null;
    }
    cancelCallbacks.clear();
  };

  return {
    controller,
    get signal() {
      return controller.signal;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    get forceRequested() {
      return forceRequested;
    },
    get lastSignal() {
      return lastSignal;
    },
    onCancel,
    requestShutdown,
    dispose,
  };
}

/**
 * Throw if the abort signal is already aborted.
 *
 * @param {AbortSignal | undefined | null} signal
 */
export function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new ShutdownError('Operation aborted by shutdown signal', {
    code: 'SHUTDOWN_ABORTED',
    cause: reason,
  });
}

/**
 * Race a promise against abort. Rejects when the signal fires.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined | null} signal
 * @returns {Promise<T>}
 */
export function raceWithAbort(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new ShutdownError('Operation aborted by shutdown signal', {
            code: 'SHUTDOWN_ABORTED',
            cause: signal.reason,
          }),
    );
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new ShutdownError('Operation aborted by shutdown signal', {
              code: 'SHUTDOWN_ABORTED',
              cause: signal.reason,
            }),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
