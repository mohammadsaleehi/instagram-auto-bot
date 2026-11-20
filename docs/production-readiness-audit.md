# Production Readiness Audit — Instagram Auto Bot

> **Phase B update (2026-11-20):** Phase B is complete. See
> `docs/phase-b-completion-report.md` and
> `docs/phase-b-canonical-lifecycle.md`. The findings below describe the
> pre-Phase-B baseline; Phase B resolved the canonical-lifecycle, operation
> consistency, worker outcome mapping, failure-classification, migration 007,
> and consistency-auditor items.

**Date:** 2026-11-19
**Scope:** repository-wide reliability, recovery, observability, safety, and maintainability audit.
**Constraints:** no new Instagram publication, no Share click, no commit, no push, preserve every existing change.

---

## 1. Executive summary

The browser Story path is proven end-to-end: it published `js.jpg` once, the Story appeared on `mohammad7656336`, and the viewer image matched the source at identity distance 5.23.

The system is **not production-ready yet**.

The most urgent defect was a durable-state inconsistency:

- Operation `story_pub_2026-11-19T15-48-09-603Z_x4wq33` was `PUBLICATION_UNCERTAIN / SHARE_NOT_CONFIRMED`.
- Content `0fd490d4-c860-45d8-aab8-8f4f51b8e259` was `NEEDS_ATTENTION`.
- Publishing history was `UNCERTAIN`.
- Independent read-only verification proved the Story is live and matches the source.

The automated verifier false-negative happened because it only recognized anchor-style Story rings and numeric viewer URLs. The verifier has been corrected, and Phase A now reconciles the operation transactionally without a new operation or Share click. The reconciled operation is `PUBLICATION_CONFIRMED`, content is `PUBLISHED`, history is `SUCCEEDED`, the original uncertain result is preserved in the audit trail, and a `RECONCILIATION_COMPLETED` event records the actor/reason/evidence.

Beyond Phase A, the audit found:

- Several competing publication state vocabularies.
- No canonical operation lifecycle shared by adapters, services, tasks, DB, and CLI.
- No cross-process account-level browser lock.
- Incomplete browser crash / page closure / CDP loss recovery.
- No durable reconciliation or recovery CLI.
- Task retry semantics that are safe today only because `content.publish` uses `maxAttempts: 1`.
- Partial observability: useful per-Story diagnostics, but no single task/operation/correlation trace across CLI, queue, worker, browser, and DB.
- Model configuration is OpenRouter-capable but not yet role-based (planner / content / classifier).
- Security is reasonable but not fully hardened around diagnostics, backups, and secret handling.

**Overall verdict:** NOT READY for unattended production.
**Phase A verdict after this audit:** the successful Story must be reconciled before any further work is considered complete.

---

## 2. Current incident and evidence

| Item | Value |
|---|---|
| Account | `mohammad7656336` |
| Media | `media/stories/pending/js.jpg` |
| Media SHA-256 | `37b4a25445630e990a75caf6611dda4d5a5bc0e3c344fc7d811f586bad6b4026` |
| Operation ID | `story_pub_2026-11-19T15-48-09-603Z_x4wq33` |
| Share intent | `2026-11-19T15:48:37.377Z` |
| Share click | `2026-11-19T15:48:37.699Z` |
| Share click result | `dispatched` |
| Durable state before reconciliation | `PUBLICATION_UNCERTAIN / SHARE_NOT_CONFIRMED` |
| Content state before reconciliation | `NEEDS_ATTENTION` |
| History state before reconciliation | `UNCERTAIN` |
| Live evidence | success toast, active Story tray/ring, viewer `/stories/mohammad7656336/`, timestamp `12m`, identity distance `5.23` |
| Reconciled state | `PUBLICATION_CONFIRMED` |
| Reconciled content | `PUBLISHED` at `2026-11-19T15:48:37.699Z` |
| Reconciled history | `SUCCEEDED`; original uncertain result preserved under `reconciliation` |
| Reconciliation actor | `phase-a-reconciliation` |
| Reconciliation event | `5efe0da7-0739-4f15-8ec7-cb932f1abf09` (`RECONCILIATION_COMPLETED`) |
| Story expiry | `2026-11-20T15:48:37.699Z` |

The original Share intent and click timestamps were preserved. Reconciliation did not create a second operation or a second Share attempt.

---

## 3. Architecture observed

### 3.1 Execution paths

**CLI / operator path**

```text
npm run story:publish / story:status / story:history
  -> src/cli/content-runtime.js
  -> createContentManager()
  -> ContentService / PublishingService
  -> PublishingAdapter
  -> PlaywrightStoryPublishingAdapter
  -> StoryBrowserSession / StoryEntry / StoryUpload / StoryEditor
  -> BrowserManager (existing | launch | storage-state)
  -> Instagram mobile web UI
```

**Task engine path**

```text
Application
  -> TaskManager
  -> TaskQueue / TaskRepository (atomic claim)
  -> TaskWorker (concurrency limit 1 per worker)
  -> content.publish handler
  -> PublishingService
  -> adapter
```

**Intelligence path**

```text
agent / intelligence runtime
  -> provider factory (mock | openrouter)
  -> planner / decision / tool loop
  -> content-management tools or CLI/task creation
```

No AI path was found that directly constructs the Playwright Story adapter or clicks Share. Publication remains behind content approval, the publishing service, and (for supervised real publication) the explicit `enablePublication` + one-time authorization + durable operation store gate.

### 3.2 Persistence

SQLite tables observed:

- `content_items`, `content_media`, `content_approvals`, `story_details`
- `publishing_history`
- `story_publish_operations` (migration 005)
- `tasks`, `task_events`, `schedules`
- `intelligence_*` tables (migration 004)
- `schema_migrations`

Migrations 001–005 are applied. There is no reconciliation event table and no reconciliation metadata on `story_publish_operations`.

### 3.3 Browser/session architecture

`BrowserManager` supports:

- `existing` (attach over CDP; disconnect only on close)
- `launch` / `launch-x11` (persistent isolated context)
- `storage-state` (owned browser + storage state)

Observed strengths:

- Reuses an existing page when running.
- Detects persistent-profile lock errors.
- Supports graceful application shutdown.
- Story session applies portrait metrics through CDP.

Observed gaps:

- Session ownership is per `BrowserManager` instance, not per account across processes.
- No durable account-level lock in the database.
- No automatic recovery after page closure, browser disconnect, or CDP session loss.
- No new-tab/popup ownership policy.
- Stale `page` references are not reacquired automatically.
- Multiple workers/processes could target the same account.

---

## 4. Capability inventory

| Capability | Status | Evidence / notes |
|---|---|---|
| Mobile-web Story portrait flow | Implemented | Header `+`, Post/Story menu, filechooser, editor, 1170×2532 canvas |
| CDP-only screenshots in Story path | Implemented | `Page.captureScreenshot`; no `page.screenshot()` calls in source |
| Portrait preservation | Implemented | Verified at every stage; no `setViewportSize()` calls |
| Preview image identity | Implemented | 16×16 fingerprint via CDP clip; live 5.45 in editor, 5.23 in viewer |
| Exact Share control validation | Implemented | Native `BUTTON`, exact text, enabled, bottom-bar geometry |
| Durable Share intent | Implemented | `share_intent_at` transaction in `story_publish_operations` |
| Single Share dispatch | Implemented | `clickShareOnce()` + one-time operation store constraint |
| Post-Share verification | Implemented, recently fixed | Handles link rings, button/canvas rings, numeric-less viewer URL |
| Durable reconciliation | **Implemented (Phase A)** | Transactional exact-operation reconciliation, event audit trail, dry-run, idempotency |
| Canonical lifecycle across all layers | **Missing / fragmented** | Phase B |
| Browser crash / CDP loss recovery | **Partial** | Phase C |
| Session expiry / checkpoint handling | Partial | Stops safely; no resume workflow |
| Delayed onboarding dialogs | Implemented | Entry retries dismiss modals without force-click |
| Media magic-byte validation | Implemented | `MediaManager` / `media:inspect` uses magic bytes, size, dimensions, checksum |
| Corrupt/truncated media detection | Partial | Metadata decode catches some cases; no explicit truncation test |
| Duplicate / previously published media prevention | Partial | Idempotency keys and operation share-intent guard; no global media-publication registry |
| Account-level locking | **Missing** | Phase F |
| Atomic task claiming | Implemented | `TaskRepository.claimNext()` transaction + conditional update |
| Worker heartbeat / lease renewal | **Missing** | Stale timeout only |
| Graceful shutdown | Implemented | Application shutdown controller and worker stop |
| Retry/backoff | Implemented | RetryManager; content.publish uses `maxAttempts: 1` |
| No-retry boundary after Share | Implemented in Story path | Intent + uncertain terminal state + `retryable=0` |
| Structured per-Story diagnostics | Implemented | Per-operation directory, CDP screenshots, redaction, retention |
| Unified correlation IDs | **Missing** | Phase H |
| Operation/status CLI | Partial | `story:status`, `story:history`, `story:operation`, `story:reconcile`; missing `story:verify`, `story:recover`, `story:inspect`, `story:validate` |
| OpenRouter provider | Implemented | Base URL, model, fallback models, timeout, app metadata |
| Role-based model configs | **Missing** | No separate planner/content/classifier configs |
| AI cannot bypass publication authorization | Implemented by separation | No direct adapter/Share path found |
| Secrets excluded from git | Mostly implemented | `.env` ignored; diagnostics ignored; storage state not committed |
| Backups / restore procedure | **Missing** | Phase H/J |

---

## 5. Critical findings

### P0 — Must fix before further production work

**P0-1. Uncertain live publication is not reconciled. — RESOLVED in Phase A.**
The live Story is proven, and operation/content/history are now reconciled to confirmed/published/succeeded with the original uncertain result preserved. A `RECONCILIATION_COMPLETED` event records the actor, reason, and evidence.

**P0-2. No transactional reconciliation path or audit trail. — RESOLVED in Phase A.**
`StoryReconciliationService` validates evidence and updates operation, content, history, and Story details atomically. Migration 006 adds reconciliation metadata and `story_operation_events`.

**P0-3. Automated verifier false-negative is fixed and live-validated; fixture regression pending.**
The live UI uses a `role="button"` ring with aria-label `Story by <account>, not seen`, and a viewer URL without a numeric story ID. The verifier now handles these and was re-run read-only successfully; a dedicated fixture regression test remains for Phase H.

**P0-4. Successful Share click alone must never imply PUBLISHED.**
The Story path already separates intent/click from confirmation. Reconciliation must preserve that rule: only independent viewer/account evidence can promote to PUBLISHED. Phase A.

### P1 — High risk for unattended operation

**P1-1. Fragmented state vocabularies.**
`ContentStatus` (`APPROVED`, `PUBLISHING`, `PUBLISHED`, `FAILED`, `NEEDS_ATTENTION`, `EXPIRED`), `PublishingAttemptStatus` (`STARTED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, `DRY_RUN`), `TaskStatus` (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `NEEDS_ATTENTION`), and `StoryPublishState` (`PUBLICATION_CONFIRMED`, `PUBLICATION_UNCERTAIN`, `PUBLISH_FAILED`, ...) overlap without one canonical lifecycle. Phase B.

**P1-2. `story_publish_operations` is not yet the authoritative publication record.**
Content status is still used as a proxy in CLI/status paths. The operation, content, history, and Story details can diverge. Phase A/B.

**P1-3. No cross-process account-level lock.**
Per-worker concurrency limit 1 does not prevent two processes from operating the same Instagram account. Phase F.

**P1-4. Browser/session recovery is incomplete.**
Page closure, browser crash, CDP session loss, and unexpected navigation are not automatically recovered or explicitly classified for all cases. Phase C.

**P1-5. Task retry policy is not publication-aware by default.**
`content.publish` uses `maxAttempts: 1`, which is correct, but the generic retry manager could be reused incorrectly by future handlers. The publication no-retry boundary must be enforced at the service/operation layer, not only by task configuration. Phase E/F.

**P1-6. Media-to-publication history is not globally deduplicated.**
Operation share-intent checks cover the same media checksum, but there is no global published-media registry or explicit “already live on account” check beyond Story lifetime. Phase D/E.

**P1-7. Observability is not end-to-end.**
Story diagnostics are good, but task, operation, content, account, worker, browser session, and provider/model metadata are not joined by a single correlation ID. Phase H.

**P1-8. Model configuration is not role-based.**
OpenRouter supports provider/model/base URL/key/fallback/timeout, but there is no explicit planner/content/classifier split, no per-role token/temperature policy, and no startup capability validation beyond basic model format. Phase G.

**P1-9. CLI operator surface is incomplete.**
`story:reconcile`, `story:operation`, `story:verify`, and `story:recover` are missing. `story:status` can show `NEEDS_ATTENTION` without a recovery action. Phase A/I.

### P2 — Maintainability and hardening

- Legacy alias object `story-publish-states.js` coexists with canonical `story-states.js`.
- `story-ui-selectors.js` is a quarantined catalog, but some verified constants are still duplicated in modules.
- `story_details.story_container_id` can retain a dry-run container ID after a real publication.
- `PublishingService` duplicate detection requires `externalPublishId`; a prior `DRY_RUN` with null external ID caused the observed idempotency-key collision.
- The Story viewer URL may have no numeric story ID; `externalPublishId` semantics need a canonical decision.
- Diagnostics screenshots can contain account UI; retention/redaction policy needs to be explicit.
- Documentation drift: Phase 0–4 docs say “never click Share”, while a supervised publication path now exists.

---

## 6. Failure and recovery matrix

| Failure | Current behavior | Required behavior | Gap / phase |
|---|---|---|---|
| Network down before Share | Safe failure path exists; no click | Retry allowed before intent | Verify/test; E |
| Network down after Share | Share intent/click persisted; adapter returns uncertain | Never retry; verify account | Reconciliation + E |
| Browser crash before Share | Operation may be left pre-share; task recovery may retry | Recover operation safely | C/F |
| Browser crash after Share | Intent persisted; operation uncertain | Never retry; inspect account | A/E |
| Session expired | `AUTH_REQUIRED` / checkpoint stop | Pause and request re-auth | C |
| Instagram checkpoint | `CHECKPOINT_REQUIRED`; manual intervention | Pause for manual resolution | C |
| File missing | Preflight failure before browser | Fail before browser | Implemented |
| Invalid media | Media validator fails | Fail during validation | Implemented/partial |
| Upload timeout | Upload/editor failure | Inspect current state before retry | E |
| Preview not ready | Editor not ready | Do not publish | Implemented |
| Wrong preview image | Identity mismatch | Stop immediately | Implemented |
| Share button ambiguous | Exact text/geometry/uniqueness checks | Stop immediately | Implemented |
| Share click dispatched, no response | Timeout/uncertain classification | Uncertain; verify before retry | A/E |
| Success toast but viewer unavailable | Partial evidence retained | Verify later; do not claim success | A |
| Story ring found, media mismatch | Viewer identity mismatch | Do not mark published | A |
| Duplicate task | Idempotency key / maxAttempts 1 | Prevent duplicate publication | F/E |
| Worker crashes | Stale RUNNING recovery; side-effect -> NEEDS_ATTENTION | Recover from durable operation | F |
| DB unavailable | No durable intent means no Share | Never dispatch Share without intent | E |
| Two workers same account | Not prevented across processes | Account-level lock | F |
| Instagram DOM change | Selector failures + diagnostics | Stop safely, collect diagnostics | C/H |
| Disk full | Diagnostics may fail; operation state uncertain | Stop without corrupting state | H |

---

## 7. Database and integrity findings

Strengths:

- Foreign keys and transactional migrations exist.
- Task claiming is atomic and conditional.
- `story_publish_operations.share_intent_at` is a one-way safety boundary.
- `publishing_history` and content updates are transactional in normal publishing.
- Unique idempotency keys prevent duplicate history rows.

Gaps:

- No reconciliation event table or reconciliation columns (Phase A).
- No migration rollback strategy; migrations are forward-only.
- No automated backup/restore.
- No integrity checks for orphaned content/history/operation rows.
- `story_details` can retain stale dry-run container IDs.
- `PublishingService` duplicate logic and unique idempotency key can conflict after a dry-run on a reused content item.
- `content_items.external_publish_id` is null for the live Story because the viewer URL has no numeric ID; status and external-ID semantics need a canonical decision.

---

## 8. Security findings

Observed protections:

- `.env` and generated diagnostics are ignored.
- API keys are environment/configuration references, not hardcoded.
- `data/instagram-auth.json` is mode `0600`.
- Story diagnostics redact URLs/tokens and do not write cookies/storage state.
- No undocumented Instagram endpoints are used for Story publication.
- No AI path directly bypasses publication authorization.

Open items:

- Diagnostics screenshots contain account UI; they are gitignored but not encrypted.
- Backups of `data/bot.sqlite` contain content metadata and operation evidence; backup access must be controlled.
- No automated secret scan in CI/pre-commit.
- Browser profiles/sessions directory permissions and isolation should be verified per environment.
- Path traversal on media selection is handled by exact-name resolution, but should have regression tests.
- Disk-full behavior can leave diagnostics incomplete; operation state must remain authoritative.

---

## 9. Queue / worker findings

Implemented:

- Atomic claim through a DB transaction and conditional status update.
- Stale RUNNING recovery.
- `side_effect_started` -> NEEDS_ATTENTION (no blind replay).
- Graceful application shutdown and worker stop.
- Configurable concurrency limit.

Gaps:

- No heartbeat/lease renewal; a long browser task older than the stale timeout could be recovered while still running.
- No per-account advisory lock across processes.
- No explicit worker registry/heartbeat table.
- Generic retry policy is not centrally aware of publication no-retry semantics.
- No recovery CLI to inspect/requeue/mark attention for a specific operation.

---

## 10. AI / model findings

Implemented:

- Provider abstraction (`mock`, `openrouter`).
- OpenRouter base URL, model, fallback models, timeout, app metadata.
- Error classification for auth, credits, model-not-found, rate limit, timeout, network, context length.
- Structured provider metadata logging without exposing keys.
- No direct publication/Share capability found in the AI path.

Gaps:

- Single default model configuration; no explicit planner/content/classifier roles.
- No per-role temperature/token-limit policy in configuration.
- Model capability validation is limited to format checks and runtime provider errors.
- No startup validation that the configured model exists before an operation.
- Fallback behavior is provider-level; no deterministic task-level fallback policy for planning/content.
- Structured model output validation exists in parts of the intelligence layer but should be audited per tool/plan schema.

---

## 11. Phase A implementation — complete

**Status:** complete and verified against the real operation. No new publication or Share click occurred.

Actual reconciliation result:

- Operation `story_pub_2026-11-19T15-48-09-603Z_x4wq33` → `PUBLICATION_CONFIRMED`
- Content `0fd490d4-c860-45d8-aab8-8f4f51b8e259` → `PUBLISHED`
- History row → `SUCCEEDED`
- `published_at` / `story_published_at` → `2026-11-19T15:48:37.699Z`
- Story expires → `2026-11-20T15:48:37.699Z`
- Original share intent/click timestamps and original completed time preserved
- Original uncertain result preserved under `publishing_history.result_json.reconciliation`
- Reconciliation actor/reason recorded on the operation and event
- Event `5efe0da7-0739-4f15-8ec7-cb932f1abf09` = `RECONCILIATION_COMPLETED`
- 29/29 validation checks passed in dry-run before the write
- No new operation row and no new publishing-history row
- No Instagram action was performed

Files/modules:

- `src/storage/migrations/006-story-operation-events.js`
  - reconciliation columns on `story_publish_operations`
  - `story_operation_events` audit table and indexes
- `src/modules/content/publishing/story/story-reconciliation.js`
  - exact-operation reconciliation
  - evidence validation
  - transactional operation/content/history/story-details updates
  - audit events; dry-run; idempotency
- `src/cli/commands/story-reconcile.js`
- `src/cli/commands/story-operation.js`
- `package.json` scripts
- `tests/content/story/story-reconciliation.test.js`
- `tests/content/migration-006.test.js`
- `docs/production-readiness-audit.md`
- `docs/production-readiness-report.md`

Phase A rules:

- Reconcile only operation `story_pub_2026-11-19T15-48-09-603Z_x4wq33`.
- Validate account, media checksum, share timestamps, success toast/editor closure, Story ring, viewer URL, timestamp, and image identity.
- Preserve share intent/click timestamps and original attempt history.
- No new operation, no new Share, no content mutation beyond the reconciled status.
- Transactional and idempotent.
- Record actor, reason, original state, and evidence.
- Never promote on a Share click alone.

---

## 12. Phases B–J plan

**Phase B — Canonical lifecycle and operation consistency.**
Define one publication lifecycle and transition table shared by content, attempt, operation, task, and CLI. Map legacy statuses, add guards/timestamps/recovery rules, and make the operation the authoritative external-action record.

**Phase C — Browser/session and Instagram UI reliability.**
Add explicit session ownership, page reacquisition, browser/CDP loss classification, account-level locking, popup/new-tab policy, stale page detection, UI change diagnostics, and ambiguous-selector handling.

**Phase D — Media validation and upload reliability.**
Add explicit corrupted/truncated checks, magic-byte validation tests, duplicate/published-media registry, source availability at execution time, upload timeout state inspection, and derived-asset policy.

**Phase E — Publication safety and recovery.**
Wire operation store recovery, write-ahead intent, single-dispatch enforcement, success-toast/editor-closure/viewer verification, and uncertain/no-retry rules into every publication adapter.

**Phase F — Queue, worker, concurrency.**
Add worker heartbeat/lease renewal, stale-claim protection, per-account locks, duplicate-task tests, crash recovery, and publication-aware retry policy.

**Phase G — AI model/provider architecture.**
Add role-based model configs (planner/content/classifier), startup validation, capability metadata, rate-limit/timeout/fallback policies, structured output schemas, and deterministic fallback behavior.

**Phase H — Observability, diagnostics, security.**
Add correlation IDs across task/operation/content/account/worker/session/provider, structured JSON logs, rotation/retention, bounded screenshots, health checks, backup/restore, secret scanning, and diagnostic access controls.

**Phase I — CLI and operator experience.**
Add `story:validate`, `story:inspect`, `story:operation`, `story:verify`, `story:recover`, and `story:reconcile`; make queued-vs-executed outcomes explicit; add actionable errors and account/media summaries.

**Phase J — Full regression and production-readiness validation.**
Run all tests, failure simulations, crash/recovery drills, security review, diff review, live-gated verification, and produce the final production-readiness report and verdict.

---

## 13. Current verdict

**Overall: NOT READY for unattended production.**
**Phase A: complete and verified.**
The successful Story is reconciled without republishing. The next gate is Phase B (canonical lifecycle and operation consistency). No further real publication should occur until Phases B–F (lifecycle, browser/session reliability, publication recovery, account locking) are complete and tested.
