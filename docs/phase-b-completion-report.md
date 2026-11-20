# Phase B Completion Report — Canonical Lifecycle & Operation Consistency

**Date:** 2026-11-20
**Scope:** Phase B only. No real Instagram action, no Share click, no commit, no push.

---

## 1. What was wrong in the original architecture

- Entity statuses were fragmented across `ContentStatus`, `PublishingAttemptStatus`, `StoryPublishState`, `TaskStatus`, adapter `PublishResult.status`, and reconciliation classifications.
- `TaskWorker` marked every non-throwing handler result as `COMPLETED`, including publication results that were actually `UNCERTAIN` or `FAILED`.
- `PublishingService` marked every thrown adapter error as `UNCERTAIN`, even when no Share intent existed.
- Content, publishing history, operation, and Story metadata could diverge because finalization was spread across direct SQL updates.
- No canonical, queryable `publication_outcome`.
- No general lifecycle event table.
- No read-only consistency auditor or `publication:audit` CLI.
- Worker completion had no optimistic concurrency guard; a stale worker could overwrite a newer result.
- Failure classification was scattered and did not consistently separate pre-Share failures from post-Share uncertainty.
- Adapter execution status and publication outcome were conflated.
- CLI status did not show canonical outcome, Share evidence, retryability, last transition, or recovery recommendation in one place.

---

## 2. Canonical lifecycle implemented

Canonical outcomes:

`PENDING`, `VALIDATING`, `READY`, `PUBLISHING`, `PUBLICATION_CONFIRMED`, `PUBLICATION_UNCERTAIN`, `PUBLISH_FAILED`, `CANCELLED`.

Semantics:

- `PUBLICATION_CONFIRMED`: trusted/independent evidence proves Instagram accepted and published the content.
- `PUBLICATION_UNCERTAIN`: publication may have happened; evidence is insufficient or contradictory.
- `PUBLISH_FAILED`: evidence proves publication did not occur.
- `CANCELLED`: cancelled before an irreversible publication action.

A successful Share click, task completion, upload, or editor preview never implies publication confirmation.

Entity-specific statuses were retained and mapped into the canonical outcome. The durable operation is authoritative when present.

---

## 3. Transition rules

The complete matrix and guards are in `docs/phase-b-canonical-lifecycle.md` and `src/modules/content/publishing/publication-lifecycle.js`.

Key rules:

- `PENDING → VALIDATING`.
- `VALIDATING → READY`, `PUBLISH_FAILED`, `CANCELLED`.
- `READY → PUBLISHING` only with validated authorization.
- `PUBLISHING → PUBLICATION_CONFIRMED` only with verified evidence or a simulated adapter.
- `PUBLISHING → PUBLICATION_UNCERTAIN` allowed.
- `PUBLISHING → PUBLISH_FAILED` only with conclusive no-publication evidence.
- `PUBLISHING → CANCELLED` forbidden after Share intent/click.
- `PUBLICATION_UNCERTAIN → PUBLICATION_CONFIRMED` only through verified reconciliation.
- `PUBLICATION_UNCERTAIN → PUBLISH_FAILED` only with conclusive evidence.
- `PUBLISH_FAILED → PUBLICATION_CONFIRMED` only through verified reconciliation.
- `PUBLISH_FAILED → READY/PENDING` only with an explicit safe retry and no Share evidence.
- `PUBLICATION_CONFIRMED` and `CANCELLED` are terminal for ordinary transitions.
- A guarded self-synchronization event can repair lagging content/history after the operation terminal state was already persisted.

---

## 4. Files created and modified

### Created

- `src/modules/content/publishing/publication-outcomes.js`
- `src/modules/content/publishing/publication-failure-classification.js`
- `src/modules/content/publishing/publication-adapter-contract.js`
- `src/modules/content/publishing/publication-lifecycle.js`
- `src/modules/content/publishing/publication-consistency-auditor.js`
- `src/storage/migrations/007-publication-lifecycle.js`
- `src/cli/commands/publication-audit.js`
- `tests/content/migration-007.test.js`
- `tests/content/publication-lifecycle.test.js`
- `tests/content/publication-adapter-contract.test.js`
- `tests/content/publication-consistency-auditor.test.js`
- `tests/content/publication-audit-cli.test.js`
- `tests/content/story-reconcile-cli.test.js`
- `docs/phase-b-baseline.md`
- `docs/phase-b-canonical-lifecycle.md`
- `docs/phase-b-completion-report.md`

### Modified

- `src/storage/database.js` — registers migration 007.
- `src/modules/content/constants.js` — adds `PublishingAttemptStatus.CANCELLED`.
- `src/modules/content/content-repository.js` — maps `publication_outcome` on history.
- `src/modules/content/publishing/publishing-service.js` — applies adapter results through the lifecycle service; classifies thrown errors by Share evidence.
- `src/modules/content/publishing/playwright-story-adapter.js` — emits execution/publication contract fields.
- `src/modules/content/publishing/publishing-adapter.js` — mock adapter emits contract fields.
- `src/modules/content/publishing/story/story-reconciliation.js` — writes canonical outcome and lifecycle event during reconciliation.
- `src/storage/repositories/task-repository.js` — conditional updates by expected status/claimedBy.
- `src/tasks/task-worker.js` — publication outcome mapping, no-retry boundaries, stale-worker protection.
- `src/cli/commands/story-status.js` — canonical outcome, account, Share, retryability, recovery, last transition.
- `src/cli/commands/story-operation.js` — execution vs publication distinction, lifecycle events, recovery.
- `src/cli/commands/story-publish.js` — queued outcome clarity and inline publication outcome.
- `package.json` — adds `publication:audit`.
- `tests/tasks/task-worker.test.js` — publication outcome and stale-worker tests.
- `docs/production-readiness-report.md` — Phase B update and revised verdict.

All pre-existing Phase A/Story work remains preserved and uncommitted.

---

## 5. Database migrations and data safety

Migration `007-publication-lifecycle.js`:

- adds `publication_outcome` to `story_publish_operations` and `publishing_history`;
- adds `publication_lifecycle_events`;
- backfills existing canonical outcomes;
- inserts one `MIGRATION_BACKFILL` event per existing operation;
- is forward-only and additive;
- is safe to re-run;
- does not delete or recreate records.

Verification:

- migration tested against a copy of `data/bot.sqlite` before production application;
- production schema version is now 7;
- protected operation, content, history, Story details, Share timestamps, reconciliation metadata, and reconciliation event were preserved;
- operation count remains 2; publishing-history count remains 11;
- no authentication or media files were modified.

Backups available locally (gitignored):

- `data/diagnostics/story-publication/bot.sqlite.before-migration-007`
- `data/diagnostics/story-publication/bot.sqlite.migration-007-copy`

---

## 6. Adapter contract changes

The common contract separates:

- execution status (`COMPLETED`, `FAILED`, `ABORTED`);
- execution state and Share timestamps;
- publication outcome;
- publication verification;
- simulation flag;
- failure code and classified failure;
- retryability;
- evidence;
- timestamps;
- diagnostics;
- operation/account/content identity.

Playwright and mock adapters emit the contract fields. Legacy adapters are normalized. A confirmed publication requires verified evidence or a simulated adapter; execution completion alone is insufficient.

---

## 7. Worker and retry changes

- `PUBLICATION_CONFIRMED` → `COMPLETED`.
- `PUBLICATION_UNCERTAIN` → `NEEDS_ATTENTION`; no automatic retry.
- `PUBLISH_FAILED` → `FAILED`; no automatic retry in Phase B; a new attempt requires explicit authorization.
- `CANCELLED` → `CANCELLED`.
- Dry-run/ready/no publication outcome → existing task behavior.
- Task updates use `WHERE status=RUNNING AND claimed_by=workerId`, so a stale worker cannot overwrite a newer result.
- `content.publish` remains `maxAttempts: 1`.
- Generic retry middleware cannot retry a publication-specific uncertain or failed outcome.

Phase F still needs heartbeat/lease renewal and cross-process account locking.

---

## 8. Failure classification coverage

Centralized in `publication-failure-classification.js`.

Pre-Share:

- missing/invalid media, invalid account, authentication, checkpoint, browser launch, CDP, page closed, editor unavailable, upload timeout, preview mismatch, Share disabled/ambiguous, authorization failure.

During/after Share:

- Share intent persisted but click not dispatched, click dispatched without response, browser crash/network disconnect after Share, missing success toast, toast without viewer, viewer image mismatch, account mismatch, duplicate Story, unknown platform uncertainty.

Rules:

- Post-Share ambiguity is `PUBLICATION_UNCERTAIN`, non-retryable, manual intervention.
- A timeout/crash after Share is never a confirmed failure.
- Pre-Share failures are `PUBLISH_FAILED` and may be safe to retry with a new attempt.
- `PublishingService` thrown errors are classified using durable Share evidence.

---

## 9. Consistency auditor behavior

`PublicationConsistencyAuditor` is read-only and reports:

- missing content/history;
- operation/content/history contradictions;
- confirmed content/history consistency;
- uncertain/failed content consistency;
- Share evidence marked retryable;
- missing canonical outcomes;
- missing lifecycle/reconciliation audit events;
- broken lifecycle event chains;
- stale lifecycle event outcomes;
- missing reconciliation metadata;
- duplicate Share-intent operations;
- stale RUNNING side-effect tasks.

Historical non-latest attempts are not falsely flagged when a later operation resolved the content.

CLI:

```bash
npm run publication:audit
npm run publication:audit -- --json
npm run publication:audit -- --operation=story_pub_2026-11-19T15-48-09-603Z_x4wq33 --json
```

Exit code 1 means critical inconsistencies. The auditor never modifies records or opens Instagram.

---

## 10. CLI examples

```bash
# Canonical status
npm run story:status -- 0fd490d4-c860-45d8-aab8-8f4f51b8e259

# Operation detail with execution vs publication outcome
npm run story:operation -- --operation=story_pub_2026-11-19T15-48-09-603Z_x4wq33

# Read-only consistency audit
npm run publication:audit -- --operation=story_pub_2026-11-19T15-48-09-603Z_x4wq33 --json
npm run publication:audit -- --json

# Reconciliation is dry-run by default
npm run story:reconcile -- --operation=<id> --account=<handle> --media=<path>
npm run story:reconcile -- --operation=<id> --account=<handle> --media=<path> --confirm --actor=<who> --reason=<why>

# Queued publish explicitly reports that no publication outcome exists yet
npm run story:publish -- story-01.jpg --confirm
```

---

## 11. Tests executed and exact results

```text
npm test
Test Files  55 passed (55)
Tests       339 passed (339)
Duration    46.70s
```

Phase B-focused tests:

- `migration-007.test.js` — 1 passed.
- `publication-lifecycle.test.js` — 12 passed.
- `publication-adapter-contract.test.js` — 8 passed.
- `publication-consistency-auditor.test.js` — 6 passed.
- `publication-audit-cli.test.js` — 3 passed.
- `story-reconcile-cli.test.js` — 1 passed.
- `task-worker.test.js` — 8 passed, including publication outcome mapping and stale-worker protection.
- Existing Story, reconciliation, dry-run, migration, and browser-fixture suites remain green.

`git diff --check` is clean.

---

## 12. Protected Story regression verification

Operation `story_pub_2026-11-19T15-48-09-603Z_x4wq33`:

- Operation state: `PUBLICATION_CONFIRMED`
- Canonical outcome: `PUBLICATION_CONFIRMED`
- Failure: `NULL`
- Retryable: `0`
- Share intent: `2026-11-19T15:48:37.377Z`
- Share click: `2026-11-19T15:48:37.699Z`
- Completed: `2026-11-19T15:50:25.365Z`
- Reconciled: `2026-11-19T16:43:21.597Z` by `phase-a-reconciliation`
- Content: `PUBLISHED`, published `2026-11-19T15:48:37.699Z`
- History: `SUCCEEDED`, canonical `PUBLICATION_CONFIRMED`
- Reconciliation event `5efe0da7-0739-4f15-8ec7-cb932f1abf09` preserved
- Operation count: 2 (earlier pre-Share failed attempt + published attempt)
- Publishing-history count: 11 (unchanged)
- Protected-operation audit: 1 consistent, 0 critical, 0 warnings
- Global audit: 2 consistent, 0 critical, 0 warnings
- No new Share, no new operation, no new publishing-history row
- `data/instagram-auth.json` and `media/stories/pending/js.jpg` unchanged.

---

## 13. Git status

- Branch: `main`, tracking `origin/main`.
- No commit, no push, no staged files.
- Phase B files are uncommitted alongside the preserved Phase A and Story work.
- Generated diagnostics, database copies, and backups are under gitignored `data/diagnostics/`.
- No browser profiles, cookies, or secrets are staged.

---

## 14. Remaining Phase C–J risks

- **C:** browser/session ownership, browser crash, page closure, CDP loss, unexpected navigation, popups/new tabs, account-level locking.
- **D:** corrupted/truncated media, global published-media registry, source availability, derived-asset policy.
- **E:** publication recovery across all adapters, explicit `NOT_PUBLISHED` recovery semantics, crash-after-Share drills.
- **F:** worker heartbeat/lease renewal, cross-process account locking, duplicate-task/crash recovery, graceful shutdown drills.
- **G:** role-based planner/content/classifier model configuration, startup model validation, per-role limits.
- **H:** correlation IDs across task/operation/content/account/worker/session/provider, log rotation, bounded screenshots, backup/restore, secret scanning.
- **I:** `story:validate`, `story:inspect`, `story:verify`, `story:recover`.
- Fixture regression test for the real button/canvas Story ring and numeric-less viewer URL.
- `external_publish_id` remains `null` when the viewer URL has no numeric story ID; semantics must be decided.
- No real Instagram testing in Phase B.

---

## 15. Honest readiness verdict

**Overall production readiness: NOT READY.**

**Phase B: complete and verified.**

Evidence categories:

- **Implemented:** canonical lifecycle, migration 007, adapter contract, worker mapping, failure classification, auditor, CLI reporting.
- **Unit tested:** lifecycle transitions, guards, mappings, failure classification, adapter contract, auditor, worker outcomes.
- **Integration tested:** in-memory databases, migrations, transactions/rollback, stale workers, CLI audit/reconciliation.
- **Browser-tested with fixtures:** existing Playwright Story integration suite; no real Instagram publishing in Phase B.
- **Verified against existing production records:** protected Story operation, content, history, reconciliation event, row counts, audit.
- **Tested against real Instagram:** not in Phase B. The only real Instagram evidence remains the earlier Phase A publication and independent viewer verification.

The next gate is **Phase C — browser/session and account-locking reliability**. No further real publication should occur until the remaining safety and recovery phases are complete and tested.
