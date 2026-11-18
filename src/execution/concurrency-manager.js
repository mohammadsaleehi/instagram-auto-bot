/**
 * Single-account concurrency gate. Default concurrency is 1.
 */
export class ConcurrencyManager {
  /**
   * @param {{ limit?: number }} [options]
   */
  constructor(options = {}) {
    this.limit = Math.max(1, options.limit ?? 1);
    this._active = 0;
  }

  /**
   * @returns {number}
   */
  get active() {
    return this._active;
  }

  /**
   * @returns {boolean}
   */
  canAcquire() {
    return this._active < this.limit;
  }

  /**
   * @returns {boolean}
   */
  tryAcquire() {
    if (!this.canAcquire()) {
      return false;
    }
    this._active += 1;
    return true;
  }

  /**
   * @returns {void}
   */
  release() {
    if (this._active > 0) {
      this._active -= 1;
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    if (!this.tryAcquire()) {
      throw new Error('Concurrency limit reached');
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
