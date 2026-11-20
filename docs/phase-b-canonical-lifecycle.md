# Phase B — Canonical Publication Lifecycle

**Date:** 2026-11-20
**Scope:** one authoritative publication lifecycle across content, operations, history, adapters, workers, CLI, and the consistency auditor.
**No real Instagram action was performed in Phase B.**

---

## 1. Why this exists

Before Phase B, publication state was split across:

- `ContentStatus` (`PUBLISHED`, `FAILED`, `NEEDS_ATTENTION`, …)
- `PublishingAttemptStatus` (`SUCCEEDED`, `FAILED`, `UNCERTAIN`, `DRY_RUN`, …)
- `StoryPublishState` (`PUBLICATION_CONFIRMED`, `SHARE_INVOKED`, …)
- `TaskStatus` (`COMPLETED`, `FAILED`, `NEEDS_ATTENTION`, …)
- adapter `PublishResult.status`
- reconciliation `classification`

This caused:

- a task returning `COMPLETED` even when publication was uncertain;
- a thrown adapter error being marked `UNCERTAIN` even before Share;
- content/history/operation drift;
- no canonical queryable outcome;
- no general lifecycle event table;
- no read-only consistency auditor.

Phase B keeps the entity-specific statuses but introduces one canonical publication outcome and a central service that maps and synchronizes them.

---

## 2. Canonical outcomes

Defined in `src/modules/content/publishing/publication-outcomes.js`:

| Outcome | Meaning |
|---|---|
| `PENDING` | Publication has not started preparation. |
| `VALIDATING` | Media/account/content validation or preparation is in progress. |
| `READY` | Prepared and authorized; no Share action has occurred. |
| `PUBLISHING` | A publication action is in progress or has a Share intent. |
| `PUBLICATION_CONFIRMED` | Independent/trusted evidence proves Instagram accepted and published the content. |
| `PUBLICATION_UNCERTAIN` | Publication may have happened; evidence is insufficient or contradictory. |
| `PUBLISH_FAILED` | Evidence proves publication did not occur. |
| `CANCELLED` | Cancelled before an irreversible publication action. |

Semantic rules:

- A successful task execution is **not** publication confirmation.
- Upload success or an editor preview is **not** publication confirmation.
- A Share click alone is **not** publication confirmation.
- A timeout or browser crash after a Share click is **not** a confirmed failure.
- Reconciliation is the only ordinary path from `PUBLICATION_UNCERTAIN` to `PUBLICATION_CONFIRMED`.

---

## 3. Entity mappings

`src/modules/content/publishing/publication-lifecycle.js` defines:

- `CONTENT_STATUS_TO_OUTCOME`
- `ATTEMPT_STATUS_TO_OUTCOME`
- `STORY_STATE_TO_OUTCOME`
- `derivePublicationOutcome({operation, content, history, task})`
- `assertPublicationTransition(from, to, guards)`

| Entity status | Canonical outcome |
|---|---|
| Content `DRAFT` | `PENDING` |
| Content `READY_FOR_REVIEW` | `VALIDATING` |
| Content `APPROVED`, `SCHEDULED` | `READY` |
| Content `PUBLISHING` | `PUBLISHING` |
| Content `PUBLISHED`, `EXPIRED` | `PUBLICATION_CONFIRMED` |
| Content `FAILED` | `PUBLISH_FAILED` |
| Content `NEEDS_ATTENTION` | `PUBLICATION_UNCERTAIN` |
| Content `CANCELLED`, `REJECTED` | `CANCELLED` |
| History `STARTED` | `PUBLISHING` |
| History `SUCCEEDED` | `PUBLICATION_CONFIRMED` |
| History `FAILED` | `PUBLISH_FAILED` |
| History `UNCERTAIN` | `PUBLICATION_UNCERTAIN` |
| History `DRY_RUN` | `READY` |
| History `CANCELLED` | `CANCELLED` |
| Story `INITIALIZING` | `PENDING` |
| Story `PREFLIGHT` … `EDITOR_LOADING` | `VALIDATING` |
| Story `EDITOR_READY`, `PRE_SHARE_SNAPSHOT`, `DRY_RUN_COMPLETE` | `READY` |
| Story `SHARE_ARMED`, `SHARE_INVOKED`, `POST_SHARE_OBSERVING` | `PUBLISHING` |
| Story `PUBLICATION_CONFIRMED` | `PUBLICATION_CONFIRMED` |
| Story `PUBLICATION_UNCERTAIN` | `PUBLICATION_UNCERTAIN` |
| Story `PUBLISH_FAILED`, `AUTH_REQUIRED`, `CHECKPOINT_REQUIRED` | `PUBLISH_FAILED` |
| Story `ABORTED` | `CANCELLED` |
| Task `COMPLETED` alone | **no publication implication** |
| Task `FAILED` alone | **no publication implication** |

The operation is authoritative when it exists. If the operation has no explicit canonical outcome, terminal Story states win; otherwise Share evidence/history/content determine the outcome.

---

## 4. Transition matrix

| From \ To | PENDING | VALIDATING | READY | PUBLISHING | CONFIRMED | UNCERTAIN | FAILED | CANCELLED |
|---|---|---|---|---|---|---|---|---|
| PENDING | — | ✅ | — | — | — | — | — | ✅ |
| VALIDATING | — | — | ✅ | — | — | — | ✅ | ✅ |
| READY | — | — | — | ✅ | — | — | ✅ | ✅ |
| PUBLISHING | — | — | ✅* | — | ✅† | ✅ | ✅‡ | ✅§ |
| PUBLICATION_UNCERTAIN | — | — | — | — | ✅¶ | — | ✅‡ | — |
| PUBLISH_FAILED | ✅** | — | ✅** | — | ✅¶ | — | — | — |
| PUBLICATION_CONFIRMED | — | — | — | — | — | — | — | — |
| CANCELLED | — | — | — | — | — | — | — | — |

Guards:

- `*` dry-run restore only: `allowDryRunRestore === true`.
- `†` `verifiedEvidence === true` or `simulated === true` (mock adapters only).
- `‡` conclusive no-publication evidence: `allowConclusiveFailure && conclusiveNoPublication`.
- `§` no Share intent/click. An operation with Share evidence cannot be cancelled.
- `¶` verified reconciliation only: `allowReconciliation && verifiedEvidence`.
- `**` explicit safe retry only: `explicitRetry === true` and no Share intent/click.
- `PUBLISHING` requires `authorizationValidated !== false`.
- Terminal `PUBLICATION_CONFIRMED` and `CANCELLED` have no ordinary outgoing transitions.
- Self-transition is allowed only as an explicit synchronization (`allowSynchronization`) to repair a lagging content/history row after the operation terminal state was already persisted.

---

## 5. Lifecycle service and trusted boundaries

`PublicationLifecycleService` provides:

- `getPublicationState()`
- `transitionPublication()`
- `confirmPublication()`
- `markPublicationUncertain()`
- `markPublicationFailed()`
- `cancelPublication()`
- `applyAdapterResult()`
- `classifyThrownError()`
- `validateConsistency()`
- `reconcilePublicationState()`

Trusted boundaries:

- **StoryOperationStore** — durable Share intent/click boundary; never creates a second Share.
- **StoryReconciliationService** — verified reconciliation boundary; now writes canonical `publication_outcome` and a lifecycle event.
- **PublicationLifecycleService** — all ordinary publication transitions.

Atomicity:

- Every transition runs in `BEGIN IMMEDIATE`.
- Operation, content, history, Story details, and lifecycle event are updated together.
- Conditional updates use the expected current status where applicable.
- A transaction failure rolls back every update and leaves no event.
- Re-reading inside the transaction detects concurrent state changes.
- `completed_at` is preserved for self-synchronization and reconciliation.

---

## 6. Database

Migration `007-publication-lifecycle.js`:

- adds `publication_outcome` to `story_publish_operations`;
- adds `publication_outcome` to `publishing_history`;
- adds `publication_lifecycle_events` with operation/content/history/task references, actor, event, previous/new outcome, reason, and evidence;
- backfills existing operation/history canonical outcomes;
- inserts one `MIGRATION_BACKFILL` event per existing operation;
- is forward-only, additive, and safe to re-run.

Data safety:

- No table/row deletion or recreation.
- Existing Share timestamps, completed times, reconciliation metadata, and `story_operation_events` are preserved.
- Migration was tested against a copy of the production database before applying.
- The protected operation remained `PUBLICATION_CONFIRMED`, content `PUBLISHED`, history `SUCCEEDED`, retryable `0`, with the original reconciliation event.

---

## 7. Adapter contract

`src/modules/content/publishing/publication-adapter-contract.js` standardizes:

- `operationId`
- `accountId`
- `contentId`
- `execution.status` (`COMPLETED`, `FAILED`, `ABORTED`)
- `execution.state` and Share timestamps
- `publication.outcome`
- `publication.verified`
- `publication.simulated`
- `failureCode` and classified `failure`
- `retryable`
- `evidence`
- `timestamps`
- `diagnostics`

Legacy adapters are normalized. Execution success alone never becomes publication confirmation; confirmation requires `verified` evidence or a simulated adapter.

Playwright and mock adapters now emit the contract fields. The Graph adapter is normalized with platform acceptance as trusted evidence.

---

## 8. Worker and retry policy

`TaskWorker` now inspects the returned publication outcome:

| Publication outcome | Task status | Automatic retry |
|---|---|---|
| `PUBLICATION_CONFIRMED` | `COMPLETED` | No |
| `PUBLICATION_UNCERTAIN` | `NEEDS_ATTENTION` | No |
| `PUBLISH_FAILED` | `FAILED` | No automatic retry in Phase B |
| `CANCELLED` | `CANCELLED` | No |
| `READY` / no outcome | `COMPLETED` | Existing retry policy |

- `PUBLISH_FAILED` requires a new explicitly authorized attempt; the failed task is not retried by the generic retry manager.
- A task marked successful does not imply publication.
- A task marked failed does not imply publication failed.
- Worker completion/retry/failure updates use `WHERE status=RUNNING AND claimed_by=workerId`; a stale worker cannot overwrite a newer result.
- `content.publish` remains `maxAttempts: 1`.

Phase F still needs heartbeat/lease renewal and cross-process account locking.

---

## 9. Failure classification

`src/modules/content/publishing/publication-failure-classification.js` defines stable codes with outcome, retryability, recovery action, Share possibility, and manual-intervention flag.

Pre-Share examples:

`MEDIA_MISSING`, `MEDIA_INVALID`, `ACCOUNT_INVALID`, `AUTHENTICATION_REQUIRED`, `CHECKPOINT_REQUIRED`, `BROWSER_LAUNCH_FAILED`, `CDP_CONNECTION_FAILED`, `PAGE_CLOSED`, `EDITOR_UNAVAILABLE`, `UPLOAD_TIMEOUT`, `PREVIEW_MISMATCH`, `SHARE_DISABLED`, `SHARE_AMBIGUOUS`, `AUTHORIZATION_FAILED`.

During/after Share examples:

`SHARE_INTENT_NOT_DISPATCHED`, `SHARE_DISPATCHED_NO_RESPONSE`, `BROWSER_CRASH_AFTER_SHARE`, `NETWORK_DISCONNECT_AFTER_SHARE`, `SUCCESS_TOAST_MISSING`, `TOAST_VISIBLE_VIEWER_UNAVAILABLE`, `VIEWER_IMAGE_MISMATCH`, `ACCOUNT_MISMATCH`, `DUPLICATE_STORY`, `PLATFORM_ERROR_UNCERTAIN`.

Rules:

- Post-Share ambiguity defaults to `PUBLICATION_UNCERTAIN`, `retryable=false`, `manualIntervention=true`.
- `PublishingService` no longer marks every thrown error as uncertain; it checks the durable operation for Share evidence. No Share evidence → safe failure; Share evidence → uncertain.

---

## 10. Idempotency

- Content identity: content ID + account/platform context.
- Media identity: SHA-256, not filename.
- Operation identity: durable operation ID.
- Idempotency key: unique publishing-history key; a real attempt uses a fresh key when reusing a content item.
- Share boundary: `story_publish_operations.share_intent_at` with a transactional conflict query.
- A confirmed publication is terminal for that operation and blocks ordinary republishing.
- A dry-run cannot collide with a real Share operation.
- Duplicate detection is database-backed and survives restarts.
- Reconciliation is idempotent.
- The auditor reports duplicate Share-intent operations for the same idempotency key or content/media checksum.

---

## 11. Consistency auditor

`PublicationConsistencyAuditor` is read-only.

It checks:

- missing content/history;
- operation/content/history outcome contradictions;
- confirmed content/history consistency;
- uncertain content state;
- failed-after-Share records without reconciliation;
- Share evidence marked retryable;
- missing canonical outcomes;
- missing lifecycle/reconciliation audit events;
- broken lifecycle event chains;
- stale lifecycle event outcomes;
- reconciliation metadata;
- duplicate Share-intent operations;
- stale RUNNING side-effect tasks.

Historical non-latest attempts are treated as historical for content-status checks, so a failed pre-Share attempt whose content was later published by a different confirmed operation is not falsely flagged.

CLI:

```bash
npm run publication:audit
npm run publication:audit -- --json
npm run publication:audit -- --operation=story_pub_2026-11-19T15-48-09-603Z_x4wq33 --json
```

Exit code 1 means at least one critical inconsistency. The auditor never modifies records or opens Instagram.

---

## 12. CLI behavior

`story:status` now reports:

- account
- operation
- canonical publication outcome and source
- last transition
- Share intent/click
- retryability
- recovery recommendation
- consistency warnings
- content/attempt/reconciliation details

`story:operation` distinguishes:

- execution state (Story state)
- canonical publication outcome
- account, retryability, recovery
- last lifecycle transition
- lifecycle events and reconciliation events
- verification evidence

`story:publish` queued output explicitly states that no publication outcome exists yet.

`story:reconcile` remains dry-run-first and requires `--confirm` for writes.

---

## 13. Protected operation verification

Operation `story_pub_2026-11-19T15-48-09-603Z_x4wq33` after Phase B:

- Operation: `PUBLICATION_CONFIRMED`
- Canonical outcome: `PUBLICATION_CONFIRMED`
- Failure: `NULL`
- Retryable: `0`
- Share intent: `2026-11-19T15:48:37.377Z`
- Share click: `2026-11-19T15:48:37.699Z`
- Completed: `2026-11-19T15:50:25.365Z`
- Reconciled: `2026-11-19T16:43:21.597Z` by `phase-a-reconciliation`
- Content: `PUBLISHED`, published `2026-11-19T15:48:37.699Z`
- History: `SUCCEEDED`, canonical `PUBLICATION_CONFIRMED`
- Original reconciliation event `5efe0da7-0739-4f15-8ec7-cb932f1abf09` preserved
- Operation count: 2 (earlier pre-Share failed attempt + published attempt)
- History count: 11 (unchanged)
- Protected operation audit: 1 consistent, 0 critical, 0 warnings
- Global audit: 2 consistent, 0 critical, 0 warnings
- No new Share, no new operation, no new publishing-history row.

---

## 14. Known limitations / Phase C–J

- No cross-process account lock or browser session ownership.
- No heartbeat/lease renewal; stale timeout only.
- Browser crash/page closure/CDP loss recovery remains partial.
- Media corruption/truncation and a global published-media registry remain incomplete.
- AI role-based planner/content/classifier configuration remains Phase G.
- End-to-end correlation IDs, log rotation, backups/restore, and secret scanning remain Phase H.
- CLI still needs `story:validate`, `story:inspect`, `story:verify`, `story:recover`.
- A fixture regression test for the button/canvas Story viewer ring remains.
- `external_publish_id` is `null` when the Instagram viewer URL has no numeric story ID.
- Real Instagram testing is **not** part of Phase B.
