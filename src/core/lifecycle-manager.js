/**
 * Tracks high-level application lifecycle states.
 */
export const ApplicationState = Object.freeze({
  STARTING: 'STARTING',
  AUTHENTICATING: 'AUTHENTICATING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

export class LifecycleManager {
  /**
   * @param {{
   *   eventsBus?: import('./event-bus.js').EventBus | null,
   *   nowFn?: () => Date,
   * }} [options]
   */
  constructor(options = {}) {
    this.eventsBus = options.eventsBus ?? null;
    this._now = options.nowFn ?? (() => new Date());
    this.state = ApplicationState.STARTING;
    this.startedAt = null;
    this.stoppedAt = null;
  }

  /**
   * @param {string} next
   */
  transition(next) {
    const previous = this.state;
    this.state = next;
    if (next === ApplicationState.RUNNING && !this.startedAt) {
      this.startedAt = this._now().toISOString();
    }
    if (next === ApplicationState.STOPPED || next === ApplicationState.FAILED) {
      this.stoppedAt = this._now().toISOString();
    }
    this.eventsBus?.emit('lifecycle.changed', { previous, next });
  }
}
