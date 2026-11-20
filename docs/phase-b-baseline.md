# Phase B Baseline — Canonical Lifecycle & Operation Consistency

**Date:** 2026-11-20
**Branch:** `main` tracking `origin/main`
**Constraint:** no Instagram action, no Share, no media/auth changes, no commit/push.

---

## 1. Protected publication invariant

Operation:

`story_pub_2026-11-19T15-48-09-603Z_x4wq33`

Read-only verification before Phase B:

| Record | State |
|---|---|
| `story_publish_operations.state` | `PUBLICATION_CONFIRMED` |
| `failure_code` | `NULL` |
| `retryable` | `0` |
| `share_intent_at` | `2026-11-19T15:48:37.377Z` |
| `share_clicked_at` | `2026-11-19T15:48:37.699Z` |
| `completed_at` | `2026-11-19T15:50:25.365Z` |
| `reconciled_at` | `2026-11-19T16:43:21.597Z` |
| `reconciled_by` | `phase-a-reconciliation` |
| `previous_state` | `PUBLICATION_UNCERTAIN` |
| `previous_failure_code` | `SHARE_NOT_CONFIRMED` |
| Content | `PUBLISHED` at `2026-11-19T15:48:37.699Z` |
| Publishing history | `SUCCEEDED` |
| Story details | published `2026-11-19T15:48:37.699Z`, expires `2026-11-20T15:48:37.699Z` |
| Reconciliation event | `5efe0da7-0739-4f15-8ec7-cb932f1abf09` |

The original uncertain result is preserved under `publishing_history.result_json.reconciliation`; the original Share timestamps and completed time are preserved.

---

## 2. Repository baseline

- `main...origin/main`; no ahead/behind.
- Phase A and earlier Story work remain uncommitted.
- 13 tracked files modified; Phase A files and earlier Story files untracked.
- No commit, no push, no staged files.
- Baseline tests before Phase B: **49 files / 306 tests passed**.
- Schema migrations: 001–006 applied.
- Production database: `data/bot.sqlite`; storage state `data/instagram-auth.json` unchanged.
- Media: `media/stories/pending/js.jpg` unchanged.

---

## 3. Existing lifecycle-related models

### `ContentStatus` (`src/modules/content/constants.js`)

`DRAFT`, `READY_FOR_REVIEW`, `APPROVED`, `REJECTED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`, `NEEDS_ATTENTION`, `CANCELLED`, `EXPIRED`.

Used as a content lifecycle, but also read as a publication outcome in several places.

### `PublishingAttemptStatus`

`STARTED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, `DRY_RUN`.

Used for `publishing_history.status`.

### `TaskStatus`

`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `NEEDS_ATTENTION`.

Execution status; currently **not** tied to a canonical publication outcome.

### `StoryPublishState`

`INITIALIZING`, `PREFLIGHT`, `NAVIGATING_HOME`, `AUTH_VERIFIED`, `SURFACE_READY`, `CREATE_MENU_OPEN`, `STORY_OPTION_VERIFIED`, `FILECHOOSER_ARMED`, `STORY_OPTION_CLICKED`, `FILE_SELECTED`, `EDITOR_LOADING`, `EDITOR_READY`, `PRE_SHARE_SNAPSHOT`, `SHARE_ARMED`, `SHARE_INVOKED`, `POST_SHARE_OBSERVING`, `PUBLICATION_CONFIRMED`, `PUBLICATION_UNCERTAIN`, `PUBLISH_FAILED`, `ABORTED`, `AUTH_REQUIRED`, `CHECKPOINT_REQUIRED`, `DRY_RUN_COMPLETE`.

Legacy aliases exist in `story-publish-states.js`.

### Reconciliation outcome

`StoryReconciliationService` returns `PUBLISHED`, `PUBLICATION_UNCERTAIN`, `PUBLISH_FAILED`, or `NOT_PUBLISHED`.

### Adapter result

`PublishResult` currently carries `status` (`SUCCEEDED`, `FAILED`, `UNCERTAIN`, `DRY_RUN`), `simulated`, IDs, message, and `raw`. It does not separate execution outcome from publication outcome.

---

## 4. Current execution path

```text
CLI / task engine
  -> ContentService / PublishingService
  -> PublishingAdapter (playwright | mock | graph)
  -> PlaywrightStoryPublishingAdapter
  -> StoryOperationStore (Share intent/click boundary)
  -> browser / Instagram UI
  -> publishing_history + content_items + story_details
```

`PublishingService._finalizeAttempt()` directly updates history, content, and Story details based on the adapter `status`. The adapter itself does not update content, but the service does not yet have a canonical lifecycle service.

---

## 5. Contradictions and gaps found

1. **Task COMPLETED does not mean publication confirmed.** `TaskWorker._executeClaimed()` marks every non-throwing handler result as `COMPLETED`, including a publication result that may be `UNCERTAIN` or `FAILED`.
2. **Adapter execution status and publication outcome are conflated.** `PublishResult.status` mixes execution and publication semantics.
3. **`PublishingService` catch marks every thrown adapter error as `UNCERTAIN`**, even if no Share intent existed.
4. **`ContentStatus`, history status, operation state, and task status can diverge.** Phase A fixed one historical inconsistency, but the general synchronization path is still scattered.
5. **No canonical `publication_outcome` column** on operations/history.
6. **No general lifecycle event table**; only `story_operation_events` for reconciliation.
7. **No read-only consistency auditor** or `publication:audit` CLI.
8. **No optimistic concurrency in worker completion updates**; a stale worker can overwrite a newer task result.
9. **No central failure classification** for pre-Share vs post-Share outcomes.
10. **Idempotency is split** across content idempotency keys, operation media checksum/intent checks, task idempotency keys, and history uniqueness.
11. **Adapter contract is implicit**; mock and Playwright results have different shapes.
12. **Existing reconciliation is a trusted boundary** but is Story-specific and not exposed as a generic lifecycle operation.
13. **`story:status` does not show canonical publication outcome, Share intent/click, retryability, or recovery recommendation in one place.**
14. **Legacy status mappings are duplicated** in CLI/status and tests.

---

## 6. Baseline decisions for Phase B

- Preserve all existing entity statuses; add a canonical publication outcome mapping instead of renaming everything.
- Make `story_publish_operations` the authoritative external-action record when it exists.
- Add `publication_outcome` to operations and publishing history via a new forward-only migration 007.
- Add `publication_lifecycle_events` for all transitions.
- Keep the Phase A reconciliation service as the trusted reconciliation boundary; the lifecycle service exposes `reconcilePublicationState()` as a delegate.
- Keep the Share-intent/click store as the trusted irreversible-action boundary.
- Do not touch migration 006 or existing production records destructively.
- Do not perform a real Instagram action.

---

## 7. Planned Phase B subphases

- **B1:** canonical outcome definitions, mappings, transition matrix.
- **B2:** `PublicationLifecycleService` with validation, atomic writes, events, retryability.
- **B3:** migration 007, idempotency/consistency checks, production-copy migration test.
- **B4:** adapter contract normalization and `PublishingService` integration.
- **B5:** task worker honors publication outcome; stale-update guard; retry safety.
- **B6:** central failure classification and recovery recommendations.
- **B7:** consistency auditor and `publication:audit`; CLI status/operation updates.
- **B8:** regression, protected-operation verification, documentation.

---

## 8. Baseline test commands

```bash
npm test
git diff --check
git status --short
```

Protected operation SQL is read-only and will be run before and after implementation.
