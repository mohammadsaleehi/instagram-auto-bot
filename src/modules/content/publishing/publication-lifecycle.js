import {
  ContentStatus,
  ContentType,
  PublishingAttemptStatus,
  STORY_TTL_MS,
} from '../constants.js';
import { ContentRepository } from '../content-repository.js';
import { StoryPublishState } from './story/story-states.js';
import { PublicationOutcome } from './publication-outcomes.js';
import {
  classifyPublicationFailure,
  failureCodeFromError,
} from './publication-failure-classification.js';
import { normalizeAdapterResult } from './publication-adapter-contract.js';

const S = StoryPublishState;
const O = PublicationOutcome;

export { PublicationOutcome };

export const CONTENT_STATUS_TO_OUTCOME = Object.freeze({
  [ContentStatus.DRAFT]: O.PENDING,
  [ContentStatus.READY_FOR_REVIEW]: O.VALIDATING,
  [ContentStatus.APPROVED]: O.READY,
  [ContentStatus.REJECTED]: O.CANCELLED,
  [ContentStatus.SCHEDULED]: O.READY,
  [ContentStatus.PUBLISHING]: O.PUBLISHING,
  [ContentStatus.PUBLISHED]: O.PUBLICATION_CONFIRMED,
  [ContentStatus.FAILED]: O.PUBLISH_FAILED,
  [ContentStatus.NEEDS_ATTENTION]: O.PUBLICATION_UNCERTAIN,
  [ContentStatus.CANCELLED]: O.CANCELLED,
  [ContentStatus.EXPIRED]: O.PUBLICATION_CONFIRMED,
});

export const ATTEMPT_STATUS_TO_OUTCOME = Object.freeze({
  [PublishingAttemptStatus.STARTED]: O.PUBLISHING,
  [PublishingAttemptStatus.SUCCEEDED]: O.PUBLICATION_CONFIRMED,
  [PublishingAttemptStatus.FAILED]: O.PUBLISH_FAILED,
  [PublishingAttemptStatus.UNCERTAIN]: O.PUBLICATION_UNCERTAIN,
  [PublishingAttemptStatus.DRY_RUN]: O.READY,
  [PublishingAttemptStatus.CANCELLED]: O.CANCELLED,
});

export const STORY_STATE_TO_OUTCOME = Object.freeze({
  [S.INITIALIZING]: O.PENDING,
  [S.PREFLIGHT]: O.VALIDATING,
  [S.NAVIGATING_HOME]: O.VALIDATING,
  [S.AUTH_VERIFIED]: O.VALIDATING,
  [S.SURFACE_READY]: O.VALIDATING,
  [S.CREATE_MENU_OPEN]: O.VALIDATING,
  [S.STORY_OPTION_VERIFIED]: O.VALIDATING,
  [S.FILECHOOSER_ARMED]: O.VALIDATING,
  [S.STORY_OPTION_CLICKED]: O.VALIDATING,
  [S.FILE_SELECTED]: O.VALIDATING,
  [S.EDITOR_LOADING]: O.VALIDATING,
  [S.EDITOR_READY]: O.READY,
  [S.PRE_SHARE_SNAPSHOT]: O.READY,
  [S.SHARE_ARMED]: O.PUBLISHING,
  [S.SHARE_INVOKED]: O.PUBLISHING,
  [S.POST_SHARE_OBSERVING]: O.PUBLISHING,
  [S.PUBLICATION_CONFIRMED]: O.PUBLICATION_CONFIRMED,
  [S.PUBLICATION_UNCERTAIN]: O.PUBLICATION_UNCERTAIN,
  [S.PUBLISH_FAILED]: O.PUBLISH_FAILED,
  [S.ABORTED]: O.CANCELLED,
  [S.AUTH_REQUIRED]: O.PUBLISH_FAILED,
  [S.CHECKPOINT_REQUIRED]: O.PUBLISH_FAILED,
  [S.DRY_RUN_COMPLETE]: O.READY,
});

/**
 * Publication transition matrix. Guards are enforced by
 * `assertPublicationTransition`.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const PUBLICATION_TRANSITIONS = Object.freeze({
  [O.PENDING]: Object.freeze([O.VALIDATING, O.CANCELLED]),
  [O.VALIDATING]: Object.freeze([O.READY, O.PUBLISH_FAILED, O.CANCELLED]),
  [O.READY]: Object.freeze([O.PUBLISHING, O.PUBLISH_FAILED, O.CANCELLED]),
  [O.PUBLISHING]: Object.freeze([
    O.PUBLICATION_CONFIRMED,
    O.PUBLICATION_UNCERTAIN,
    O.PUBLISH_FAILED,
    O.CANCELLED,
    O.READY, // explicit dry-run restore only
  ]),
  [O.PUBLICATION_UNCERTAIN]: Object.freeze([
    O.PUBLICATION_CONFIRMED,
    O.PUBLISH_FAILED,
  ]),
  [O.PUBLISH_FAILED]: Object.freeze([
    O.PUBLICATION_CONFIRMED,
    O.READY,
    O.PENDING,
  ]),
  [O.PUBLICATION_CONFIRMED]: Object.freeze([]),
  [O.CANCELLED]: Object.freeze([]),
});

export class PublicationLifecycleError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'PublicationLifecycleError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {string} status
 * @returns {string|null}
 */
export function mapContentStatus(status) {
  return CONTENT_STATUS_TO_OUTCOME[status] ?? null;
}

/**
 * @param {string} status
 * @returns {string|null}
 */
export function mapAttemptStatus(status) {
  return ATTEMPT_STATUS_TO_OUTCOME[status] ?? null;
}

/**
 * @param {string} state
 * @returns {string|null}
 */
export function mapStoryState(state) {
  return STORY_STATE_TO_OUTCOME[state] ?? null;
}

/**
 * @param {{
 *   operation?: Record<string, any>|null,
 *   content?: Record<string, any>|null,
 *   history?: Record<string, any>|null,
 *   task?: Record<string, any>|null,
 * }} input
 * @returns {{
 *   outcome: string|null,
 *   source: string,
 *   contradictions: Array<{code: string, message: string}>,
 * }}
 */
export function derivePublicationOutcome(input) {
  const contradictions = [];
  const operation = input.operation ?? null;
  const content = input.content ?? null;
  const history = input.history ?? null;
  const task = input.task ?? null;

  let outcome = null;
  let source = 'none';

  if (operation) {
    const explicit =
      operation.publication_outcome &&
      Object.values(O).includes(operation.publication_outcome)
        ? operation.publication_outcome
        : null;
    const stateOutcome = mapStoryState(operation.state);
    const terminalState = [
      O.PUBLICATION_CONFIRMED,
      O.PUBLICATION_UNCERTAIN,
      O.PUBLISH_FAILED,
      O.CANCELLED,
    ].includes(stateOutcome);
    if (explicit) {
      outcome = explicit;
    } else if (terminalState) {
      outcome = stateOutcome;
    } else if (operation.share_intent_at || operation.share_clicked_at) {
      outcome = O.PUBLISHING;
    } else if (
      history?.status === PublishingAttemptStatus.STARTED ||
      content?.status === ContentStatus.PUBLISHING
    ) {
      outcome = O.PUBLISHING;
    } else {
      outcome = stateOutcome;
    }
    source = 'operation';
  }

  if (!outcome && history) {
    outcome =
      (history.publication_outcome &&
        Object.values(O).includes(history.publication_outcome) &&
        history.publication_outcome) ||
      mapAttemptStatus(history.status);
    source = 'history';
  }

  if (!outcome && content) {
    outcome = mapContentStatus(content.status);
    source = 'content';
  }

  if (!outcome && task) {
    if (task.status === 'PENDING') outcome = O.PENDING;
    else if (task.status === 'RUNNING') outcome = O.PUBLISHING;
    else if (task.status === 'CANCELLED') outcome = O.CANCELLED;
    // COMPLETED / FAILED / NEEDS_ATTENTION alone are not publication outcomes.
    source = 'task';
  }

  if (operation) {
    if (operation.state === S.PUBLICATION_CONFIRMED) {
      if (content && ![ContentStatus.PUBLISHED, ContentStatus.EXPIRED].includes(content.status)) {
        contradictions.push({
          code: 'CONFIRMED_OPERATION_CONTENT_NOT_PUBLISHED',
          message: `Operation is PUBLICATION_CONFIRMED but content status is ${content.status}.`,
        });
      }
      if (history && history.status !== PublishingAttemptStatus.SUCCEEDED) {
        contradictions.push({
          code: 'CONFIRMED_OPERATION_HISTORY_NOT_SUCCEEDED',
          message: `Operation is PUBLICATION_CONFIRMED but history status is ${history.status}.`,
        });
      }
    }
    if (operation.state === S.PUBLICATION_UNCERTAIN && content && content.status !== ContentStatus.NEEDS_ATTENTION) {
      contradictions.push({
        code: 'UNCERTAIN_OPERATION_CONTENT_NOT_ATTENTION',
        message: `Operation is PUBLICATION_UNCERTAIN but content status is ${content.status}.`,
      });
    }
    if (operation.state === S.PUBLISH_FAILED && content && content.status === ContentStatus.PUBLISHED) {
      contradictions.push({
        code: 'FAILED_OPERATION_CONTENT_PUBLISHED',
        message: 'Operation is PUBLISH_FAILED but content is PUBLISHED.',
      });
    }
    if ((operation.share_intent_at || operation.share_clicked_at) && Number(operation.retryable) === 1) {
      contradictions.push({
        code: 'SHARE_EVIDENCE_RETRYABLE',
        message: 'Operation has a Share intent/click but is marked retryable.',
      });
    }
  }

  if (history?.status === PublishingAttemptStatus.SUCCEEDED && content && content.status !== ContentStatus.PUBLISHED) {
    contradictions.push({
      code: 'SUCCEEDED_HISTORY_CONTENT_NOT_PUBLISHED',
      message: `History is SUCCEEDED but content status is ${content.status}.`,
    });
  }

  return { outcome, source, contradictions };
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{
 *   shareIntentRecorded?: boolean,
 *   shareClicked?: boolean,
 *   allowReconciliation?: boolean,
 *   verifiedEvidence?: boolean,
 *   simulated?: boolean,
 *   allowConclusiveFailure?: boolean,
 *   conclusiveNoPublication?: boolean,
 *   explicitRetry?: boolean,
 *   allowDryRunRestore?: boolean,
 *   authorizationValidated?: boolean,
 * }} [options]
 */
export function assertPublicationTransition(from, to, options = {}) {
  if (!Object.values(O).includes(from)) {
    throw new PublicationLifecycleError(
      'INVALID_PUBLICATION_STATE',
      `Unknown current publication outcome: ${from}`,
      { from, to },
    );
  }
  if (!Object.values(O).includes(to)) {
    throw new PublicationLifecycleError(
      'INVALID_PUBLICATION_STATE',
      `Unknown requested publication outcome: ${to}`,
      { from, to },
    );
  }

  const allowed = PUBLICATION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new PublicationLifecycleError(
      'INVALID_PUBLICATION_TRANSITION',
      `Publication transition ${from} -> ${to} is not allowed.`,
      { from, to },
    );
  }

  if (to === O.PUBLICATION_CONFIRMED) {
    if ((from === O.PUBLICATION_UNCERTAIN || from === O.PUBLISH_FAILED) && !options.allowReconciliation) {
      throw new PublicationLifecycleError(
        'RECONCILIATION_REQUIRED',
        `${from} -> PUBLICATION_CONFIRMED requires explicit verified reconciliation.`,
        { from, to },
      );
    }
    if (!options.verifiedEvidence && !options.simulated) {
      throw new PublicationLifecycleError(
        'VERIFIED_EVIDENCE_REQUIRED',
        'PUBLICATION_CONFIRMED requires independently verified evidence.',
        { from, to },
      );
    }
  }

  if (to === O.PUBLISH_FAILED && (from === O.PUBLISHING || from === O.PUBLICATION_UNCERTAIN)) {
    if (!options.allowConclusiveFailure || !options.conclusiveNoPublication) {
      throw new PublicationLifecycleError(
        'CONCLUSIVE_FAILURE_EVIDENCE_REQUIRED',
        'A post-Share operation cannot be marked PUBLISH_FAILED without conclusive evidence that no publication occurred.',
        { from, to },
      );
    }
  }

  if (to === O.CANCELLED && (options.shareIntentRecorded || options.shareClicked)) {
    throw new PublicationLifecycleError(
      'CANCEL_AFTER_SHARE_FORBIDDEN',
      'An operation with a Share intent cannot be cancelled.',
      { from, to },
    );
  }

  if ((to === O.READY || to === O.PENDING) && from === O.PUBLISH_FAILED && !options.explicitRetry) {
    throw new PublicationLifecycleError(
      'EXPLICIT_RETRY_REQUIRED',
      'PUBLISH_FAILED can only return to READY/PENDING with an explicit safe retry.',
      { from, to },
    );
  }

  if (to === O.READY && from === O.PUBLISHING && !options.allowDryRunRestore) {
    throw new PublicationLifecycleError(
      'DRY_RUN_RESTORE_REQUIRED',
      'PUBLISHING can only return to READY for an explicit dry-run restore.',
      { from, to },
    );
  }

  if (to === O.PUBLISHING && options.authorizationValidated === false) {
    throw new PublicationLifecycleError(
      'AUTHORIZATION_REQUIRED',
      'PUBLISHING requires validated authorization.',
      { from, to },
    );
  }
}

/**
 * Central publication lifecycle service.
 *
 * All ordinary publication transitions go through this service. The
 * StoryOperationStore remains the trusted irreversible Share-intent boundary;
 * StoryReconciliationService remains the trusted verified-reconciliation
 * boundary.
 */
export class PublicationLifecycleService {
  /**
   * @param {{
   *   database: import('../../../storage/database.js').Database,
   *   repository?: ContentRepository,
   *   reconciliationService?: object|null,
   *   nowFn?: () => Date,
   *   idFn?: () => string,
   * }} options
   */
  constructor(options) {
    const database = options.database ?? options.repository?.db;
    if (!database) {
      throw new Error('PublicationLifecycleService requires a database');
    }
    this.db = database;
    this.repository =
      options.repository ?? new ContentRepository(database);
    this.reconciliationService = options.reconciliationService ?? null;
    this._now = options.nowFn ?? (() => new Date());
    this._id =
      options.idFn ??
      (() => {
        // Avoid importing randomUUID at module load; crypto is available.
        return globalThis.crypto.randomUUID();
      });
  }

  /**
   * @param {{ operationId?: string|null, contentId?: string|null }} input
   * @returns {{
   *   outcome: string|null,
   *   source: string,
   *   contradictions: Array<{code: string, message: string}>,
   *   operation: Record<string, any>|null,
   *   content: Record<string, any>|null,
   *   history: Record<string, any>|null,
   *   accountId: string|null,
   *   taskId: string|null,
   *   shareIntentAt: string|null,
   *   shareClickedAt: string|null,
   *   retryable: boolean,
   *   failureCode: string|null,
   *   evidence: Record<string, any>,
   * }}
   */
  getPublicationState(input = {}) {
    const loaded = this._load(input);
    const derived = derivePublicationOutcome(loaded);
    const evidence = this._parseEvidence(loaded.operation?.evidence_json);
    return {
      ...derived,
      operation: loaded.operation,
      content: loaded.content,
      history: loaded.history,
      accountId: this._accountId(loaded.operation, evidence),
      taskId: null,
      shareIntentAt: loaded.operation?.share_intent_at ?? null,
      shareClickedAt: loaded.operation?.share_clicked_at ?? null,
      retryable: Boolean(Number(loaded.operation?.retryable ?? 0)),
      failureCode: loaded.operation?.failure_code ?? loaded.history?.error_json ?? null,
      evidence,
    };
  }

  /**
   * @param {{
   *   operationId?: string|null,
   *   contentId?: string|null,
   *   historyId?: string|null,
   *   taskId?: string|null,
   *   to: string,
   *   actor?: string,
   *   reason?: string,
   *   failure?: ReturnType<typeof classifyPublicationFailure>|null,
   *   evidence?: Record<string, any>|null,
   *   historyPatch?: Record<string, any>|null,
   *   publishedAt?: string|null,
   *   externalPublishId?: string|null,
   *   simulated?: boolean,
   *   verifiedEvidence?: boolean,
   *   allowReconciliation?: boolean,
   *   allowConclusiveFailure?: boolean,
   *   conclusiveNoPublication?: boolean,
   *   explicitRetry?: boolean,
   *   allowDryRunRestore?: boolean,
   *   authorizationValidated?: boolean,
   *   allowSynchronization?: boolean,
   *   dryRun?: boolean,
   *   testHooks?: { beforeCommit?: () => void },
   * }} input
   */
  transitionPublication(input) {
    const actor = String(input.actor ?? 'publication-lifecycle');
    const reason = String(input.reason ?? 'Publication lifecycle transition.');
    const now = this._now();
    const nowIso = now.toISOString();
    const loaded = this._load(input);
    const current = derivePublicationOutcome(loaded);
    if (!current.outcome) {
      throw new PublicationLifecycleError(
        'PUBLICATION_STATE_UNKNOWN',
        'Cannot transition publication state: no authoritative operation/content/history outcome exists.',
        { operationId: loaded.operation?.id ?? null, contentId: loaded.content?.id ?? null },
      );
    }

    const operation = loaded.operation;
    const content = loaded.content;
    const history = loaded.history;
    const shareIntentRecorded = Boolean(operation?.share_intent_at);
    const shareClicked = Boolean(operation?.share_clicked_at);
    const selfTransition = current.outcome === input.to;

    if (selfTransition) {
      if (!input.allowSynchronization) {
        if (input.to === O.PUBLICATION_CONFIRMED) {
          return {
            ok: true,
            alreadyConfirmed: true,
            previousOutcome: current.outcome,
            outcome: current.outcome,
            operation: loaded.operation,
            content: loaded.content,
            history: loaded.history,
            eventId: null,
          };
        }
        throw new PublicationLifecycleError(
          'PUBLICATION_STATE_UNCHANGED',
          `Publication is already ${input.to}; no transition was applied.`,
          { outcome: input.to },
        );
      }
      if (
        input.to === O.PUBLICATION_CONFIRMED &&
        !input.verifiedEvidence &&
        !input.simulated
      ) {
        throw new PublicationLifecycleError(
          'VERIFIED_EVIDENCE_REQUIRED',
          'PUBLICATION_CONFIRMED requires independently verified evidence.',
          { outcome: input.to },
        );
      }
      if (
        input.to === O.PUBLISH_FAILED &&
        (shareIntentRecorded || shareClicked) &&
        !(input.allowConclusiveFailure && input.conclusiveNoPublication)
      ) {
        throw new PublicationLifecycleError(
          'CONCLUSIVE_FAILURE_EVIDENCE_REQUIRED',
          'A post-Share operation cannot be marked PUBLISH_FAILED without conclusive evidence that no publication occurred.',
          { outcome: input.to },
        );
      }
    } else {
      assertPublicationTransition(current.outcome, input.to, {
        shareIntentRecorded,
        shareClicked,
        allowReconciliation: input.allowReconciliation,
        verifiedEvidence: input.verifiedEvidence,
        simulated: input.simulated,
        allowConclusiveFailure: input.allowConclusiveFailure,
        conclusiveNoPublication: input.conclusiveNoPublication,
        explicitRetry: input.explicitRetry,
        allowDryRunRestore: input.allowDryRunRestore,
        authorizationValidated:
          input.to === O.PUBLISHING ? input.authorizationValidated : undefined,
      });
    }

    const failure =
      input.failure ??
      classifyPublicationFailure(
        input.to === O.PUBLICATION_UNCERTAIN
          ? 'PLATFORM_ERROR_UNCERTAIN'
          : input.to === O.PUBLISH_FAILED
            ? 'UNKNOWN'
            : 'UNKNOWN',
        {
          outcome: input.to,
          shareMayHaveOccurred: shareIntentRecorded || shareClicked,
        },
      );

    const publishedAt =
      input.publishedAt ??
      input.evidence?.publishedAt ??
      operation?.share_clicked_at ??
      nowIso;
    const expiresAt =
      content?.contentType === ContentType.STORY
        ? new Date(Date.parse(publishedAt) + STORY_TTL_MS).toISOString()
        : null;

    const operationState =
      input.to === O.PUBLICATION_CONFIRMED
        ? S.PUBLICATION_CONFIRMED
        : input.to === O.PUBLICATION_UNCERTAIN
          ? S.PUBLICATION_UNCERTAIN
          : input.to === O.PUBLISH_FAILED
            ? S.PUBLISH_FAILED
            : input.to === O.CANCELLED
              ? S.ABORTED
              : input.to === O.PUBLISHING && shareIntentRecorded
                ? S.SHARE_ARMED
                : null;

    const contentStatus =
      input.to === O.PUBLICATION_CONFIRMED
        ? ContentStatus.PUBLISHED
        : input.to === O.PUBLICATION_UNCERTAIN
          ? ContentStatus.NEEDS_ATTENTION
          : input.to === O.PUBLISH_FAILED
            ? ContentStatus.FAILED
            : input.to === O.CANCELLED
              ? ContentStatus.CANCELLED
              : input.to === O.PUBLISHING
                ? ContentStatus.PUBLISHING
                : input.to === O.READY && input.allowDryRunRestore
                  ? ContentStatus.APPROVED
                  : null;

    const historyStatus =
      input.historyPatch?.status ??
      (input.to === O.PUBLICATION_CONFIRMED
        ? PublishingAttemptStatus.SUCCEEDED
        : input.to === O.PUBLICATION_UNCERTAIN
          ? PublishingAttemptStatus.UNCERTAIN
          : input.to === O.PUBLISH_FAILED
            ? PublishingAttemptStatus.FAILED
            : input.to === O.CANCELLED
              ? PublishingAttemptStatus.CANCELLED
              : input.to === O.PUBLISHING
                ? PublishingAttemptStatus.STARTED
                : input.to === O.READY && input.allowDryRunRestore
                  ? PublishingAttemptStatus.DRY_RUN
                  : null);

    const retryable =
      input.to === O.PUBLISH_FAILED && !shareIntentRecorded && !shareClicked;
    const completedAt =
      [O.PUBLICATION_CONFIRMED, O.PUBLISH_FAILED, O.CANCELLED].includes(input.to)
        ? current.outcome === input.to && operation?.completed_at
          ? operation.completed_at
          : current.outcome === O.PUBLICATION_UNCERTAIN &&
              input.to === O.PUBLICATION_CONFIRMED
            ? operation?.completed_at ?? nowIso
            : nowIso
        : null;

    const plan = {
      previousOutcome: current.outcome,
      outcome: input.to,
      operationState,
      contentStatus,
      historyStatus,
      failure,
      retryable,
      completedAt,
      publishedAt,
      expiresAt,
      actor,
      reason,
      evidence: input.evidence ?? null,
      historyPatch: input.historyPatch ?? null,
      externalPublishId: input.externalPublishId ?? null,
      simulated: Boolean(input.simulated),
    };

    if (input.dryRun) {
      return {
        ok: true,
        previousOutcome: current.outcome,
        outcome: input.to,
        wouldChange: true,
        plan,
        operation: loaded.operation,
        content: loaded.content,
        history: loaded.history,
        eventId: null,
      };
    }

    const eventId = this._id();
    try {
      this.db.transaction(() => {
        const fresh = this._load(input);
        const freshCurrent = derivePublicationOutcome(fresh);
        if (freshCurrent.outcome !== current.outcome) {
          throw new PublicationLifecycleError(
            'PUBLICATION_STATE_CONFLICT',
            `Publication state changed during transition (${current.outcome} -> ${freshCurrent.outcome}).`,
            { expected: current.outcome, actual: freshCurrent.outcome },
          );
        }

        if (fresh.operation) {
          const fields = {
            publication_outcome: input.to,
            failure_code:
              input.to === O.PUBLISH_FAILED || input.to === O.PUBLICATION_UNCERTAIN
                ? input.failure?.code ?? failure.code
                : null,
            retryable: retryable ? 1 : 0,
            updated_at: nowIso,
          };
          if (operationState) {
            fields.state = operationState;
            fields.state_entered_at = nowIso;
          }
          if (completedAt) fields.completed_at = completedAt;
          if (
            input.to === O.PUBLICATION_CONFIRMED &&
            (current.outcome === O.PUBLICATION_UNCERTAIN || current.outcome === O.PUBLISH_FAILED)
          ) {
            fields.reconciled_at = nowIso;
            fields.reconciled_by = actor;
            fields.reconciliation_reason = reason;
            fields.previous_state = fresh.operation.state;
            fields.previous_failure_code = fresh.operation.failure_code;
          }
          const changed = updateById(
            this.db.raw,
            'story_publish_operations',
            fresh.operation.id,
            fields,
          );
          if (changed !== 1) {
            throw new PublicationLifecycleError(
              'PUBLICATION_STATE_CONFLICT',
              'Operation update did not affect exactly one row.',
            );
          }
        }

        if (fresh.content && contentStatus) {
          const fields = {
            status: contentStatus,
            updated_at: nowIso,
          };
          if (input.to === O.PUBLICATION_CONFIRMED) {
            fields.published_at = publishedAt;
            fields.external_publish_id = input.externalPublishId ?? null;
            fields.last_error = null;
          } else if (input.to === O.PUBLISH_FAILED || input.to === O.PUBLICATION_UNCERTAIN) {
            fields.last_error = failure.message;
          } else if (input.to === O.CANCELLED) {
            fields.last_error = null;
          } else if (input.to === O.READY && input.allowDryRunRestore) {
            fields.last_error = null;
          }
          const changed = updateById(
            this.db.raw,
            'content_items',
            fresh.content.id,
            fields,
            { status: fresh.content.status },
          );
          if (changed !== 1) {
            throw new PublicationLifecycleError(
              'PUBLICATION_STATE_CONFLICT',
              'Content update did not affect exactly one row.',
              { expectedStatus: fresh.content.status },
            );
          }
        }

        if (fresh.history && historyStatus) {
          const fields = {
            status: historyStatus,
            publication_outcome: input.to,
            ...(input.historyPatch ?? {}),
          };
          if (!Object.prototype.hasOwnProperty.call(fields, 'completed_at') && completedAt) {
            fields.completed_at = completedAt;
          }
          if (input.historyPatch?.result_json !== undefined) {
            fields.result_json = input.historyPatch.result_json;
          }
          const changed = updateById(
            this.db.raw,
            'publishing_history',
            fresh.history.id,
            fields,
            { status: fresh.history.status },
          );
          if (changed !== 1) {
            throw new PublicationLifecycleError(
              'PUBLICATION_STATE_CONFLICT',
              'Publishing history update did not affect exactly one row.',
              { expectedStatus: fresh.history.status },
            );
          }
        }

        if (
          input.to === O.PUBLICATION_CONFIRMED &&
          fresh.content &&
          fresh.content.contentType === ContentType.STORY
        ) {
          const media = fresh.content.media?.[0] ?? null;
          const existing = this.repository.getStoryDetails(fresh.content.id);
          this.repository.upsertStoryDetails(fresh.content.id, {
            storyMediaType: media?.mediaKind === 'video' ? 'VIDEO' : 'IMAGE',
            storyGroupId: existing?.storyGroupId ?? null,
            sequenceOrder: existing?.sequenceOrder ?? 0,
            storyContainerId:
              input.historyPatch?.container_id ?? input.evidence?.storyId ?? null,
            storyPublishedAt: publishedAt,
            storyExpiresAt: expiresAt,
          });
        } else if (
          [O.READY, O.PUBLICATION_UNCERTAIN, O.PUBLISH_FAILED].includes(input.to) &&
          fresh.content &&
          fresh.content.contentType === ContentType.STORY
        ) {
          const existing = this.repository.getStoryDetails(fresh.content.id);
          const containerId = input.historyPatch?.container_id ?? null;
          if (existing && containerId) {
            this.repository.upsertStoryDetails(fresh.content.id, {
              storyMediaType: existing.storyMediaType,
              storyGroupId: existing.storyGroupId,
              sequenceOrder: existing.sequenceOrder,
              storyContainerId: containerId,
            });
          }
        }

        this.db.raw
          .prepare(
            `INSERT INTO publication_lifecycle_events (
              id, operation_id, content_id, history_id, task_id, at, actor,
              event, previous_outcome, new_outcome, reason, evidence_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            fresh.operation?.id ?? null,
            fresh.content?.id ?? input.contentId ?? null,
            fresh.history?.id ?? input.historyId ?? null,
            input.taskId ?? null,
            nowIso,
            actor,
            selfTransition ? 'PUBLICATION_SYNCHRONIZED' : 'PUBLICATION_TRANSITION',
            current.outcome,
            input.to,
            reason,
            JSON.stringify({
              plan,
              evidence: input.evidence ?? null,
              shareIntentAt: fresh.operation?.share_intent_at ?? null,
              shareClickedAt: fresh.operation?.share_clicked_at ?? null,
            }),
          );

        input.testHooks?.beforeCommit?.();
      });
    } catch (error) {
      if (error instanceof PublicationLifecycleError) throw error;
      throw new PublicationLifecycleError(
        'PUBLICATION_TRANSITION_FAILED',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    return {
      ok: true,
      previousOutcome: current.outcome,
      outcome: input.to,
      wouldChange: true,
      plan,
      operation: this._load(input).operation,
      content: this._load(input).content,
      history: this._load(input).history,
      eventId,
    };
  }

  /**
   * @param {Parameters<PublicationLifecycleService['transitionPublication']>[0]} input
   */
  confirmPublication(input) {
    const state = this.getPublicationState(input);
    if (state.outcome === O.PUBLICATION_CONFIRMED) {
      return {
        ok: true,
        alreadyConfirmed: true,
        previousOutcome: O.PUBLICATION_CONFIRMED,
        outcome: O.PUBLICATION_CONFIRMED,
        operation: state.operation,
        content: state.content,
        history: state.history,
      };
    }
    if (
      state.outcome === O.PUBLICATION_UNCERTAIN ||
      state.outcome === O.PUBLISH_FAILED
    ) {
      return this.reconcilePublicationState({
        operationId: input.operationId,
        actor: input.actor,
        reason: input.reason,
        expectedAccountHandle: input.evidence?.accountHandle,
        sourceMediaPath: input.evidence?.sourceMediaPath,
        dryRun: input.dryRun,
      });
    }
    return this.transitionPublication({ ...input, to: O.PUBLICATION_CONFIRMED });
  }

  /** @param {Parameters<PublicationLifecycleService['transitionPublication']>[0]} input */
  markPublicationUncertain(input) {
    return this.transitionPublication({
      ...input,
      to: O.PUBLICATION_UNCERTAIN,
      failure:
        input.failure ??
        classifyPublicationFailure(
          input.failureCode ?? 'PLATFORM_ERROR_UNCERTAIN',
          { outcome: O.PUBLICATION_UNCERTAIN, shareMayHaveOccurred: true },
        ),
    });
  }

  /** @param {Parameters<PublicationLifecycleService['transitionPublication']>[0]} input */
  markPublicationFailed(input) {
    return this.transitionPublication({
      ...input,
      to: O.PUBLISH_FAILED,
      failure:
        input.failure ??
        classifyPublicationFailure(input.failureCode ?? 'UNKNOWN'),
    });
  }

  /** @param {Parameters<PublicationLifecycleService['transitionPublication']>[0]} input */
  cancelPublication(input) {
    return this.transitionPublication({
      ...input,
      to: O.CANCELLED,
      failure:
        input.failure ??
        classifyPublicationFailure('CANCELLED_BEFORE_SHARE'),
    });
  }

  /**
   * Apply an adapter result. The adapter never writes publication records
   * directly; this is the single trusted application point.
   *
   * @param {{
   *   contentId: string,
   *   historyId: string,
   *   operationId?: string|null,
   *   taskId?: string|null,
   *   result: Record<string, any>,
   *   caps?: Record<string, any>|null,
   *   dryRun?: boolean,
   * }} input
   */
  applyAdapterResult(input) {
    const result = input.result ?? {};
    const caps = input.caps ?? {};
    const normalized = normalizeAdapterResult(result, {
      caps,
      contentId: input.contentId,
      operationId: input.operationId ?? result.requestId ?? null,
    });
    const simulated = normalized.publication.simulated;
    const outcome = normalized.publication.outcome;
    const verifiedEvidence = normalized.publication.verified;
    const state = this.getPublicationState({
      operationId: normalized.operationId,
      contentId: input.contentId,
      historyId: input.historyId,
    });
    const shareMayHaveOccurred = Boolean(
      state.shareIntentAt || state.shareClickedAt,
    );
    let finalOutcome = outcome;
    let failure =
      normalized.publication.failure ??
      classifyPublicationFailure(
        normalized.publication.failureCode ??
          (outcome === O.PUBLICATION_UNCERTAIN
            ? 'PLATFORM_ERROR_UNCERTAIN'
            : outcome === O.PUBLISH_FAILED
              ? failureCodeFromError({ message: result.message, code: result.raw?.error })
              : 'UNKNOWN'),
        {
          outcome,
          shareMayHaveOccurred,
        },
      );
    if (finalOutcome === O.PUBLISH_FAILED && shareMayHaveOccurred) {
      finalOutcome = O.PUBLICATION_UNCERTAIN;
      failure = classifyPublicationFailure(
        'PLATFORM_ERROR_UNCERTAIN',
        { outcome: finalOutcome, shareMayHaveOccurred: true },
      );
    }
    const dryRunOutcome = input.dryRun === true || result.status === 'DRY_RUN';
    const nowIso = this._now().toISOString();
    const resultJson = JSON.stringify({
      ...(result.raw ?? {}),
      simulated,
      message: result.message,
      realInstagramPublication:
        !simulated && !dryRunOutcome && outcome === O.PUBLICATION_CONFIRMED,
      publicationOutcome: dryRunOutcome ? O.READY : finalOutcome,
    });
    const errorJson =
      finalOutcome === O.PUBLISH_FAILED || finalOutcome === O.PUBLICATION_UNCERTAIN
        ? JSON.stringify({ message: result.message, raw: result.raw })
        : null;

    if (dryRunOutcome) {
      return this.transitionPublication({
        contentId: input.contentId,
        historyId: input.historyId,
        operationId: normalized.operationId,
        taskId: input.taskId ?? null,
        to: O.READY,
        actor: 'publishing-service',
        reason: 'Dry-run completed; no publication action occurred.',
        allowDryRunRestore: true,
        authorizationValidated: false,
        historyPatch: {
          status: PublishingAttemptStatus.DRY_RUN,
          request_id: normalized.operationId ?? result.requestId ?? null,
          dry_run: 1,
          result_json: resultJson,
          error_json: null,
          external_publish_id: null,
          container_id: result.containerId ?? null,
          completed_at: nowIso,
        },
      });
    }

    return this.transitionPublication({
      contentId: input.contentId,
      historyId: input.historyId,
      operationId: normalized.operationId,
      taskId: input.taskId ?? null,
      to: finalOutcome,
      actor: 'publishing-service',
      reason: result.message ?? 'Adapter execution completed.',
      failure,
      verifiedEvidence,
      simulated,
      authorizationValidated: true,
      allowSynchronization: true,
      allowConclusiveFailure: finalOutcome === O.PUBLISH_FAILED,
      conclusiveNoPublication:
        finalOutcome === O.PUBLISH_FAILED && !shareMayHaveOccurred,
      externalPublishId: result.externalPublishId ?? null,
      evidence: {
        ...(normalized.publication.evidence ?? {}),
        adapterStatus: result.status,
        simulated,
        executionStatus: normalized.execution.status,
      },
      historyPatch: {
        request_id: normalized.operationId ?? input.operationId ?? null,
        dry_run: 0,
        result_json: resultJson,
        error_json: errorJson,
        external_publish_id: result.externalPublishId ?? null,
        container_id: result.containerId ?? null,
        completed_at: nowIso,
      },
    });
  }

  /**
   * Classify an unexpected thrown error without guessing that publication
   * failed when a Share may have occurred.
   *
   * @param {{ contentId: string, error: unknown }} input
   */
  classifyThrownError(input) {
    const operation = this.db.raw
      .prepare(
        `SELECT * FROM story_publish_operations
         WHERE content_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.contentId);
    const shareMayHaveOccurred = Boolean(
      operation?.share_intent_at || operation?.share_clicked_at,
    );
    const code = failureCodeFromError(input.error);
    const failure = classifyPublicationFailure(code, {
      outcome: shareMayHaveOccurred
        ? O.PUBLICATION_UNCERTAIN
        : O.PUBLISH_FAILED,
      shareMayHaveOccurred,
    });
    return {
      operation: operation ?? null,
      shareMayHaveOccurred,
      outcome: failure.outcome,
      failure,
    };
  }

  /**
   * Read-only consistency validation for one operation/content.
   * @param {{ operationId?: string|null, contentId?: string|null }} input
   */
  validateConsistency(input = {}) {
    const state = this.getPublicationState(input);
    return {
      ok: state.contradictions.length === 0,
      outcome: state.outcome,
      contradictions: state.contradictions,
      state,
    };
  }

  /**
   * Delegate verified reconciliation to the Story reconciliation boundary.
   * @param {Record<string, any>} input
   */
  async reconcilePublicationState(input) {
    let service = this.reconciliationService;
    if (!service) {
      const { StoryReconciliationService } = await import(
        './story/story-reconciliation.js'
      );
      service = new StoryReconciliationService({
        database: this.db,
        repository: this.repository,
        nowFn: this._now,
      });
    }
    return service.reconcile(input.operationId, {
      actor: input.actor,
      reason: input.reason,
      expectedAccountHandle: input.expectedAccountHandle,
      sourceMediaPath: input.sourceMediaPath,
      maxIdentityDistance: input.maxIdentityDistance,
      dryRun: input.dryRun,
    });
  }

  /**
   * @param {{ operationId?: string|null, contentId?: string|null }} input
   */
  _load(input) {
    let operation = null;
    if (input.operationId) {
      operation = this.db.raw
        .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
        .get(input.operationId);
    }
    if (!operation && !input.operationId && input.contentId) {
      operation =
        this.db.raw
          .prepare(
            'SELECT * FROM story_publish_operations WHERE content_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(input.contentId) ?? null;
    }
    const contentId = input.contentId ?? operation?.content_id ?? null;
    const content = contentId ? this.repository.getById(contentId) : null;
    let history = null;
    if (input.historyId) {
      history =
        this.db.raw
          .prepare('SELECT * FROM publishing_history WHERE id = ?')
          .get(input.historyId) ?? null;
    }
    if (!history && operation) {
      history =
        this.db.raw
          .prepare(
            'SELECT * FROM publishing_history WHERE content_id = ? AND request_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(operation.content_id, operation.id) ?? null;
    }
    if (!history && contentId && !input.historyId) {
      history =
        this.db.raw
          .prepare(
            'SELECT * FROM publishing_history WHERE content_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(contentId) ?? null;
    }
    if (history) {
      history = { ...history, status: String(history.status) };
    }
    return { operation: operation ?? null, content, history };
  }

  /** @param {unknown} value */
  _parseEvidence(value) {
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  /**
   * @param {Record<string, any>|null} operation
   * @param {Record<string, any>} evidence
   */
  _accountId(operation, evidence) {
    const direct = evidence?.accountHandle;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const profileUrl = evidence?.verification?.profileUrl;
    if (typeof profileUrl === 'string') {
      try {
        const match = new URL(profileUrl).pathname.match(/^\/([A-Za-z0-9._]+)\/$/);
        if (match) return match[1];
      } catch {
        // ignore
      }
    }
    return null;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} id
 * @param {Record<string, unknown>} fields
 * @param {Record<string, unknown>} [expected]
 * @returns {number}
 */
function updateById(db, table, id, fields, expected = {}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return 0;
  const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
  const where = ['id = ?'];
  const params = entries.map(([, value]) => value);
  params.push(id);
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    where.push(`${key} = ?`);
    params.push(value);
  }
  const result = db
    .prepare(`UPDATE ${table} SET ${setSql} WHERE ${where.join(' AND ')}`)
    .run(...params);
  return Number(result.changes);
}
