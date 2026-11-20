import {
  STORY_FAILURE_CODES,
  STORY_LEGACY_STATE_ALIASES,
  STORY_POST_SHARE_STATES,
  STORY_PRE_SHARE_FAILURE_STATES,
  STORY_STATE_TIMEOUTS,
  STORY_SUCCESS_STATES,
  STORY_TERMINAL_STATES,
  StoryPublishState,
} from './story-states.js';

/**
 * Pure Story publishing state machine.
 *
 * This module contains no Playwright, filesystem, database, or clock side
 * effects. Every browser module asks the machine to advance and the machine
 * decides whether the transition is legal. That keeps the safety-critical
 * `PUBLISH_FAILED` vs `PUBLICATION_UNCERTAIN` boundary testable without a
 * browser.
 */

const S = StoryPublishState;

/**
 * @typedef {{
 *   to: string,
 *   event: string,
 *   timeoutMs?: number,
 *   failureCode?: string,
 * }} StoryTransition
 */

/**
 * Explicit transition table. An event not listed for the current state is
 * illegal and throws. `*` entries are handled by `fail()` only.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, StoryTransition>>>>}
 */
export const STORY_TRANSITIONS = Object.freeze({
  [S.INITIALIZING]: Object.freeze({
    START: { to: S.PREFLIGHT, event: 'START' },
  }),
  [S.PREFLIGHT]: Object.freeze({
    MEDIA_OK: { to: S.NAVIGATING_HOME, event: 'MEDIA_OK' },
    MEDIA_INVALID: {
      to: S.PUBLISH_FAILED,
      event: 'MEDIA_INVALID',
      failureCode: STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID,
    },
  }),
  [S.NAVIGATING_HOME]: Object.freeze({
    HOME_LOADED: { to: S.AUTH_VERIFIED, event: 'HOME_LOADED' },
    NAVIGATION_FAILED: {
      to: S.PUBLISH_FAILED,
      event: 'NAVIGATION_FAILED',
      failureCode: STORY_FAILURE_CODES.NAVIGATION_FAILED,
    },
    AUTH_REQUIRED: {
      to: S.AUTH_REQUIRED,
      event: 'AUTH_REQUIRED',
      failureCode: STORY_FAILURE_CODES.AUTH_REQUIRED,
    },
    CHECKPOINT_REQUIRED: {
      to: S.CHECKPOINT_REQUIRED,
      event: 'CHECKPOINT_REQUIRED',
      failureCode: STORY_FAILURE_CODES.CHECKPOINT_REQUIRED,
    },
  }),
  [S.AUTH_VERIFIED]: Object.freeze({
    AUTH_OK: { to: S.SURFACE_READY, event: 'AUTH_OK' },
    AUTH_REQUIRED: {
      to: S.AUTH_REQUIRED,
      event: 'AUTH_REQUIRED',
      failureCode: STORY_FAILURE_CODES.AUTH_REQUIRED,
    },
    CHECKPOINT_REQUIRED: {
      to: S.CHECKPOINT_REQUIRED,
      event: 'CHECKPOINT_REQUIRED',
      failureCode: STORY_FAILURE_CODES.CHECKPOINT_REQUIRED,
    },
  }),
  [S.SURFACE_READY]: Object.freeze({
    SURFACE_OK: { to: S.CREATE_MENU_OPEN, event: 'SURFACE_OK' },
  }),
  [S.CREATE_MENU_OPEN]: Object.freeze({
    MENU_READY: { to: S.STORY_OPTION_VERIFIED, event: 'MENU_READY' },
  }),
  [S.STORY_OPTION_VERIFIED]: Object.freeze({
    STORY_OPTION_OK: { to: S.FILECHOOSER_ARMED, event: 'STORY_OPTION_OK' },
  }),
  [S.FILECHOOSER_ARMED]: Object.freeze({
    CHOOSER_ARMED: { to: S.STORY_OPTION_CLICKED, event: 'CHOOSER_ARMED' },
  }),
  [S.STORY_OPTION_CLICKED]: Object.freeze({
    CHOOSER_RECEIVED: { to: S.FILE_SELECTED, event: 'CHOOSER_RECEIVED' },
  }),
  [S.FILE_SELECTED]: Object.freeze({
    FILE_ACCEPTED: { to: S.EDITOR_LOADING, event: 'FILE_ACCEPTED' },
  }),
  [S.EDITOR_LOADING]: Object.freeze({
    EDITOR_DETECTED: { to: S.EDITOR_READY, event: 'EDITOR_DETECTED' },
  }),
  [S.EDITOR_READY]: Object.freeze({
    EVIDENCE_CAPTURED: { to: S.PRE_SHARE_SNAPSHOT, event: 'EVIDENCE_CAPTURED' },
    DRY_RUN_DONE: { to: S.DRY_RUN_COMPLETE, event: 'DRY_RUN_DONE' },
  }),
  [S.PRE_SHARE_SNAPSHOT]: Object.freeze({
    SHARE_INTENT_PERSISTED: { to: S.SHARE_ARMED, event: 'SHARE_INTENT_PERSISTED' },
    DRY_RUN_DONE: { to: S.DRY_RUN_COMPLETE, event: 'DRY_RUN_DONE' },
  }),
  [S.SHARE_ARMED]: Object.freeze({
    SHARE_CLICKED: { to: S.SHARE_INVOKED, event: 'SHARE_CLICKED' },
  }),
  [S.SHARE_INVOKED]: Object.freeze({
    OBSERVE: { to: S.POST_SHARE_OBSERVING, event: 'OBSERVE' },
  }),
  [S.POST_SHARE_OBSERVING]: Object.freeze({
    SHARE_CONFIRMED: { to: S.PUBLICATION_CONFIRMED, event: 'SHARE_CONFIRMED' },
    SHARE_UNCERTAIN: {
      to: S.PUBLICATION_UNCERTAIN,
      event: 'SHARE_UNCERTAIN',
      failureCode: STORY_FAILURE_CODES.SHARE_NOT_CONFIRMED,
    },
  }),
});

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isTerminalStoryState(state) {
  return STORY_TERMINAL_STATES.includes(state);
}

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isPostShareStoryState(state) {
  return STORY_POST_SHARE_STATES.includes(state);
}

/**
 * Result status for PublishingService. `PUBLISHED` is only returned when the
 * machine reached PUBLICATION_CONFIRMED. Anything after a share attempt is
 * UNCERTAIN, never FAILED.
 *
 * @param {string} state
 * @returns {'SUCCEEDED'|'UNCERTAIN'|'FAILED'|'DRY_RUN'|null}
 */
export function classifyStoryOutcome(state) {
  if (state === S.PUBLICATION_CONFIRMED) return 'SUCCEEDED';
  if (state === S.PUBLICATION_UNCERTAIN) return 'UNCERTAIN';
  if (state === S.DRY_RUN_COMPLETE) return 'DRY_RUN';
  if (state === S.AUTH_REQUIRED || state === S.CHECKPOINT_REQUIRED) return 'FAILED';
  if (STORY_PRE_SHARE_FAILURE_STATES.includes(state)) return 'FAILED';
  if (state === S.ABORTED) return 'FAILED';
  return null;
}

/**
 * Normalize legacy names so persisted diagnostics remain readable.
 *
 * @param {string} state
 * @returns {string}
 */
export function normalizeStoryState(state) {
  return STORY_LEGACY_STATE_ALIASES[state] ?? state;
}

export class StoryPublishMachine {
  /**
   * @param {{
   *   nowFn?: () => Date,
   *   initial?: string,
   * }} [options]
   */
  constructor(options = {}) {
    this._now = options.nowFn ?? (() => new Date());
    this.state = options.initial ?? S.INITIALIZING;
    this.shareIntentAt = null;
    this.shareInvokedAt = null;
    this.failureCode = null;
    this.failureMessage = null;
    /** @type {Array<{ at: string, from: string, to: string, event: string, failureCode?: string }>} */
    this.history = [];
    this._record(this.state, this.state, 'INIT');
  }

  /** @returns {boolean} */
  get isTerminal() {
    return isTerminalStoryState(this.state);
  }

  /** @returns {boolean} */
  get shareWasInvoked() {
    return Boolean(this.shareInvokedAt);
  }

  /** @returns {boolean} */
  get shareIntentRecorded() {
    return Boolean(this.shareIntentAt);
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {string} event
   * @param {string} [failureCode]
   */
  _record(from, to, event, failureCode) {
    this.history.push({
      at: this._now().toISOString(),
      from,
      to,
      event,
      ...(failureCode ? { failureCode } : {}),
    });
  }

  /**
   * @param {string} event
   * @returns {boolean}
   */
  can(event) {
    return Boolean(STORY_TRANSITIONS[this.state]?.[event]);
  }

  /**
   * @param {string} event
   * @param {{ failureCode?: string }} [details]
   * @returns {StoryTransition}
   */
  transition(event, details = {}) {
    if (this.isTerminal) {
      throw new Error(`Story machine is terminal (${this.state}); cannot apply ${event}`);
    }
    const transition = STORY_TRANSITIONS[this.state]?.[event];
    if (!transition) {
      throw new Error(`Illegal Story transition: ${this.state} --${event}--> (none)`);
    }
    const from = this.state;
    this.state = transition.to;
    const failureCode = details.failureCode ?? transition.failureCode;
    if (failureCode) {
      this.failureCode = failureCode;
    }
    this._record(from, transition.to, event, failureCode);
    return transition;
  }

  /**
   * Record the durable share intent. Phase 5+ calls this immediately before
   * the single Share click; Phase 0–4 never calls it.
   *
   * @param {string} operationId
   */
  recordShareIntent(operationId) {
    if (this.shareIntentAt) {
      throw new Error('Share intent already recorded');
    }
    this.shareIntentAt = this._now().toISOString();
    this._lastShareIntentOperationId = operationId;
    this._record(this.state, this.state, 'SHARE_INTENT');
  }

  /** Record that the single Share click was dispatched. */
  recordShareInvoked() {
    if (!this.shareIntentAt) {
      throw new Error('Cannot record Share invocation before intent');
    }
    if (this.shareInvokedAt) {
      throw new Error('Share already invoked');
    }
    this.shareInvokedAt = this._now().toISOString();
    this._record(this.state, this.state, 'SHARE_INVOKED');
  }

  /**
   * Fail closed. The classification depends only on whether a Share click may
   * have been dispatched, never on the caller's optimism.
   *
   * @param {string} code
   * @param {string} [message]
   * @returns {string} terminal state
   */
  fail(code, message) {
    if (this.isTerminal) {
      return this.state;
    }
    const from = this.state;
    const to =
      this.shareWasInvoked || this.shareIntentRecorded
        ? S.PUBLICATION_UNCERTAIN
        : S.PUBLISH_FAILED;
    this.state = to;
    this.failureCode = code ?? STORY_FAILURE_CODES.UNKNOWN;
    this.failureMessage = message ?? null;
    this._record(from, to, `FAIL:${this.failureCode}`, this.failureCode);
    return to;
  }

  /**
   * Enter a human-action terminal state (auth/challenge). These are not
   * retryable failures; they require the operator to act in the browser.
   *
   * @param {string} state
   * @param {string} code
   * @param {string} [message]
   * @returns {string}
   */
  halt(state, code, message) {
    if (state !== S.AUTH_REQUIRED && state !== S.CHECKPOINT_REQUIRED) {
      throw new Error(`halt() only supports AUTH_REQUIRED/CHECKPOINT_REQUIRED (got ${state})`);
    }
    if (this.isTerminal) return this.state;
    const from = this.state;
    this.state = state;
    this.failureCode = code ?? state;
    this.failureMessage = message ?? null;
    this._record(from, state, `HALT:${this.failureCode}`, this.failureCode);
    return state;
  }

  /**
   * Abort. Before share it is a safe failure; after share it is uncertain.
   *
   * @param {string} [reason]
   * @returns {string}
   */
  abort(reason) {
    if (this.isTerminal) {
      return this.state;
    }
    const from = this.state;
    const afterShare = this.shareWasInvoked || this.shareIntentRecorded;
    this.state = afterShare ? S.PUBLICATION_UNCERTAIN : S.ABORTED;
    this.failureCode = afterShare
      ? STORY_FAILURE_CODES.ABORTED_AFTER_SHARE
      : STORY_FAILURE_CODES.ABORTED_BEFORE_SHARE;
    this.failureMessage = reason ?? null;
    this._record(from, this.state, 'ABORT', this.failureCode);
    return this.state;
  }

  /**
   * @returns {'SUCCEEDED'|'UNCERTAIN'|'FAILED'|'DRY_RUN'|null}
   */
  outcome() {
    return classifyStoryOutcome(this.state);
  }

  /** @returns {boolean} */
  isRetryable() {
    if (this.shareIntentRecorded || this.shareWasInvoked) {
      return false;
    }
    return this.outcome() === 'FAILED';
  }

  /** @returns {Record<string, unknown>} */
  snapshot() {
    return {
      state: this.state,
      stateTimeoutMs: STORY_STATE_TIMEOUTS[this.state] ?? null,
      outcome: this.outcome(),
      retryable: this.isRetryable(),
      shareIntentAt: this.shareIntentAt,
      shareInvokedAt: this.shareInvokedAt,
      failureCode: this.failureCode,
      failureMessage: this.failureMessage,
      history: [...this.history],
    };
  }
}

export { StoryPublishState, STORY_SUCCESS_STATES, STORY_STATE_TIMEOUTS };
