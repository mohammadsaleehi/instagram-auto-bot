/**
 * @typedef {object} TaskHandler
 * @property {string} type
 * @property {string} [description]
 * @property {boolean} [requiresAuth]
 * @property {boolean} [externalSideEffect]
 * @property {(
 *   context: TaskExecutionContext,
 *   payload: Record<string, unknown>,
 *   signal: AbortSignal,
 * ) => Promise<unknown> | unknown} execute
 */

/**
 * @typedef {object} TaskExecutionContext
 * @property {import('../adapters/browser-adapter.js').BrowserAdapter} [browser]
 * @property {import('../adapters/instagram-adapter.js').InstagramAdapter} [instagram]
 * @property {{
 *   info: Function,
 *   warn: Function,
 *   error: Function,
 *   debug: Function,
 * }} logger
 * @property {import('../core/event-bus.js').EventBus} [events]
 * @property {(started?: boolean) => void} [markSideEffect]
 * @property {Record<string, unknown>} [config]
 * @property {object} task
 */

export {};
