/**
 * Minimal in-process pub/sub for runtime coordination.
 * Not a replacement for durable task-event history in SQLite.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<(payload: unknown) => void>>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} event
   * @param {(payload: unknown) => void} listener
   * @returns {() => void}
   */
  on(event, listener) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /**
   * @param {string} event
   * @param {(payload: unknown) => void} listener
   */
  off(event, listener) {
    this._listeners.get(event)?.delete(listener);
  }

  /**
   * @param {string} event
   * @param {unknown} [payload]
   */
  emit(event, payload) {
    const listeners = this._listeners.get(event);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // Listener failures must not break the emitter.
      }
    }
  }

  /**
   * @returns {void}
   */
  clear() {
    this._listeners.clear();
  }
}
