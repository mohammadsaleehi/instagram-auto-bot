import { TaskError, ErrorClass } from './constants.js';

/**
 * Registry of task handlers.
 *
 * Handler interface:
 * {
 *   type: string,
 *   description?: string,
 *   requiresAuth?: boolean,
 *   externalSideEffect?: boolean,
 *   execute: async (context, payload, signal) => result
 * }
 */
export class TaskRegistry {
  constructor() {
    /** @type {Map<string, import('./types.js').TaskHandler>} */
    this._handlers = new Map();
  }

  /**
   * @param {import('./types.js').TaskHandler} handler
   */
  register(handler) {
    if (!handler || typeof handler.type !== 'string' || !handler.type) {
      throw new TaskError('Task handler requires a non-empty type', {
        code: 'INVALID_HANDLER',
        errorClass: ErrorClass.INVALID_INPUT,
        retryable: false,
      });
    }
    if (typeof handler.execute !== 'function') {
      throw new TaskError(`Task handler "${handler.type}" requires execute()`, {
        code: 'INVALID_HANDLER',
        errorClass: ErrorClass.INVALID_INPUT,
        retryable: false,
      });
    }
    if (this._handlers.has(handler.type)) {
      throw new TaskError(`Task handler already registered: ${handler.type}`, {
        code: 'DUPLICATE_HANDLER',
        errorClass: ErrorClass.INVALID_INPUT,
        retryable: false,
      });
    }
    this._handlers.set(handler.type, Object.freeze({ ...handler }));
  }

  /**
   * @param {string} type
   * @returns {import('./types.js').TaskHandler | undefined}
   */
  get(type) {
    return this._handlers.get(type);
  }

  /**
   * @param {string} type
   * @returns {boolean}
   */
  has(type) {
    return this._handlers.has(type);
  }

  /**
   * @returns {string[]}
   */
  listTypes() {
    return [...this._handlers.keys()].sort();
  }

  /**
   * @returns {import('./types.js').TaskHandler[]}
   */
  list() {
    return [...this._handlers.values()];
  }
}
