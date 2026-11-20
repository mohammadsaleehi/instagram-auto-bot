# Instagram Story Publishing — Audit, Root-Cause Analysis, and Execution Plan

**Status:** audit deliverable only. No production code has been changed, committed, or pushed.
**Date:** 2026-11-19
**Scope:** browser-based Instagram Story publishing in this repository (Playwright + existing task/DB infrastructure).

---

## 1. Executive summary

The repository contains a large, thoughtful Story-publishing implementation (≈2,040-line adapter, explicit selector file, state names, diagnostics, DB history, CLI) and 270 passing tests. It still cannot publish a real Story. The tests pass because the browser is a hand-written fake page that treats `setFiles()` as success.

The live audit reproduced the real failure and then isolated its cause. The immediate blocker is **not** Story selectors, the create menu, the file chooser, or Instagram refusing the upload. The blocker is that the adapter destroys its own portrait emulation before and during the Story flow:

1. `_captureDiagnostics()` uses `page.screenshot()`.
2. Playwright's `page.screenshot()` internally overrides device metrics and flips `screen.orientation.type` from `portrait-primary` to `landscape-primary`.
3. `page.setViewportSize()` has the same effect.
4. Instagram then correctly shows **“Rotate your device to add to your story.”**
5. `STORY_UI.shareNames` contains `/add\s+to\s+your\s+story/i`, which matches that warning text, so `_hasShareControl()` reports a false positive.
6. The adapter enters `READY_TO_SHARE`, fails to find a real button, and returns `SHARE_FAILED` / `UNCERTAIN`.

With two changes in a live probe — **CDP `Page.captureScreenshot` instead of `page.screenshot()`**, and **never calling `page.setViewportSize()`** — the exact same UI path opens the real Story editor in ~1 second, in portrait, with `Add to your story` visible and a `1170×2532` preview canvas.

There is a second structural defect: the mandated entry point (top-header `+` immediately left of Notifications) **does not exist in the desktop layout** for this account. Desktop exposes only the sidebar `Post` control. The current “desktop first” probe therefore always burns time, takes orientation-breaking screenshots, and falls back. Mobile web portrait is the only surface that satisfies the mandated entry rule.

There is a third defect: publication is considered successful on UI text alone. No independent evidence (profile story presence / viewer identity) is required, and the uncertain-vs-failed boundary is not durable across a crash.

**Recommendation:** do not patch the existing adapter in place. Replace the Story-specific browser layer with a pure, tested state machine plus small browser primitives that cannot call `setViewportSize` or `page.screenshot`. Keep the task queue, BrowserManager, SQLite, content inbox, publishing history, CLI shell, and diagnostics location.

---

## 2. Audit method and evidence

### 2.1 Repository and runtime review

Reviewed:

- `README.md`, `docs/story-browser-publishing.md`
- `package.json` and all `story:*` CLI commands
- `src/config/config.js`
- `src/browser/browser-manager.js`
- `src/core/application.js`
- `src/modules/content/content-manager.js`
- `src/modules/content/content-service.js`
- `src/modules/content/publishing/publishing-service.js`
- `src/modules/content/publishing/publishing-adapter.js`
- `src/modules/content/publishing/playwright-story-adapter.js`
- `src/modules/content/publishing/story-ui-selectors.js`
- `src/modules/content/publishing/story-publish-states.js`
- `src/auth/auth-state.js`, `src/auth/session-persistence.js`
- `tests/content/playwright-story-adapter.test.js` and related Story tests
- SQLite schema in `src/storage/migrations/002-content.js`, `003-story.js`
- Git working tree, diff, and history

### 2.2 Test and database facts

- `npm test`: **41 files / 270 tests pass**.
- The adapter test uses a fake page with in-memory flags. It does not render Instagram and does not exercise orientation.
- `publishing_history` for adapter `playwright`:
  - `DRY_RUN`: 2
  - `FAILED`: 1
  - `UNCERTAIN`: 6
  - `SUCCEEDED` with `realInstagramPublication=true`: **0**
- Latest real attempt `a2ba8b10…` (2026-11-19T09:53:05Z): `UNCERTAIN`, `realInstagramPublication=0`.
- `data/diagnostics/story-ui/` contains **1,176 files** (584 from 2026-11-18, 591 from 2026-11-19, plus a stray probe image). Real and synthetic evidence are mixed; there is no index and no retention policy.

### 2.3 Live reproduction

Environment:

- `BROWSER_MODE=storage-state`
- `data/instagram-auth.json`
- Separate visible Chrome (`/usr/bin/google-chrome-stable`)
- Viewport **390×844**, mobile UA/touch via CDP
- Account authenticated (`AUTHENTICATED`)
- No Story was published. Probe stopped before Share.

Observed path:

| Step | Result |
| --- | --- |
| Home in portrait | `screen.orientation.type = portrait-primary` |
| Header `+` immediately left of Notifications | one match, visible |
| Normal click on `+` | Post + Story menu opened |
| Normal click on `Story` | native `filechooser` fired |
| `filechooser.setFiles(js.jpg)` | resolved; URL became `/create/story/` |
| With `page.screenshot()` in the loop | `landscape-primary` + rotate overlay for 15s+ |
| With CDP screenshots only, no `setViewportSize()` | editor ready in ~1s, `portrait-primary`, no rotate text |

Working editor evidence (`/tmp/opencode/fixed-flow-probe2/editor-evidence.json`):

```json
{
  "url": "https://www.instagram.com/create/story/",
  "orientation": "portrait-primary",
  "hasRotateText": false,
  "buttons": [
    { "tag": "BUTTON", "text": "Close", "box": { "x": 14, "y": 8, "w": 44, "h": 44 } },
    { "tag": "BUTTON", "text": "Add AI label", "box": { "x": 332, "y": 8, "w": 44, "h": 44 } },
    { "tag": "BUTTON", "text": "Add to your story", "box": { "x": 119, "y": 796, "w": 153, "h": 24 } }
  ],
  "canvases": [
    { "w": 1170, "h": 2532, "cls": "_aa3c" },
    { "w": 1170, "h": 2532, "cls": "x10l6tqk x5ve5x3" },
    { "w": 1170, "h": 2532, "cls": "x10l6tqk x5ve5x3" }
  ]
}
```

Control experiment (`/tmp/opencode/screenshot-orientation.log`):

```
after reload                     portrait-primary
after page.screenshot            landscape-primary
after reapply metrics            landscape-primary
after cdp Page.captureScreenshot portrait-primary
after page.screenshot 2          landscape-primary
after reload 2                   portrait-primary
after page.screenshot 3          landscape-primary
```

This is reproducible and deterministic on the audited build.

---

## 3. Current architecture

```text
CLI (story:publish)
  └─ openContentRuntime()
       ├─ config (PUBLISHING_ADAPTER, CONTENT_DRY_RUN, browser mode)
       ├─ ContentRepository (SQLite)
       ├─ StoryMediaInbox (validate + archive)
       ├─ ContentService (draft → approve → publishNow)
       └─ TaskRepository (content.publish, maxAttempts=1)
              │
              ▼
Engine / worker (npm start)
  └─ content.publish handler
       └─ PublishingService.publishContent()
            ├─ assertCanPublish (confirm / dry-run / type)
            ├─ idempotency lookup in publishing_history
            ├─ adapter.publish()
            │    └─ PlaywrightStoryPublishingAdapter
            │         ├─ validateAccount
            │         ├─ surface selection (desktop → mobile)
            │         ├─ header + → Post/Story menu → Story
            │         ├─ filechooser / file input
            │         ├─ preview + share detection
            │         └─ success text detection
            └─ _finalizeAttempt → content status + story_details
```

Persistence:

- `content_items` — lifecycle and idempotency key.
- `content_media` — exact file path, MIME, checksum, dimensions.
- `publishing_history` — one row per attempt, result JSON, `realInstagramPublication`.
- `story_details` — media type, container ID, publish time, expiry.
- Task queue — `content.publish`, `maxAttempts: 1`.

---

## 4. End-to-end Story flow today

1. `npm run story:publish -- <file> --confirm [--dry-run]`
2. `openContentRuntime()` loads config and builds `ContentService` + `PublishingService`.
3. `publishStoryFromMedia()` resolves the exact file (never auto-selects), validates it, copies it into the immutable media library, creates a Story draft, approves it, and calls `publishNow()`.
4. `publishNow()` requires `--confirm` unless dry-run; it enqueues `content.publish` with `maxAttempts: 1` and a content idempotency key.
5. The engine worker picks the task and calls `PublishingService.publishContent()`.
6. `publishContent()` validates transition/confirmation, checks prior history by idempotency key, sets `PUBLISHING`, creates a `STARTED` attempt, calls the adapter.
7. The adapter validates auth, navigates home, selects desktop or mobile, enters via the header create menu, gets a file chooser, uploads, waits for Share, clicks Share (real mode), waits for success text.
8. `_finalizeAttempt()` writes the result:
   - `SUCCEEDED` → `PUBLISHED` + story details + TTL.
   - `DRY_RUN` → restore `APPROVED`.
   - `UNCERTAIN` → `NEEDS_ATTENTION`; story file stays pending.
   - `FAILED` → `FAILED`; archive to `failed/`.
9. `story:status` / `story:history` / `jobs` display results.

The architecture is sound. The failure is localized to step 7 and the evidence model around it.

---

## 5. Root-cause analysis

### RC-1 (primary): diagnostics screenshots flip orientation

`_captureDiagnostics()` at `playwright-story-adapter.js:1767` calls `page.screenshot()` at line 1778. On a CDP mobile-emulated page, that call resets `screen.orientation.type` to `landscape-primary`. It is called:

- immediately after upload (`:321`, `after-file-selection`),
- inside the preview loop (`:1400`, `during-preview-loading`),
- before Share (`:353`),
- after Share (`:370`),
- plus several times during entry (`:781`, `:811`, `:875`, …).

So even if portrait were correct before the upload, the adapter itself flips it before it ever looks for the Share control.

### RC-2: `page.setViewportSize()` also flips orientation

Lines `:463` (`_enablePortraitMobile`) and `:557` (`_reassertPortrait`) call `page.setViewportSize({390,844})`. Measured effect: `landscape-primary`. Re-applying `Emulation.setDeviceMetricsOverride` afterward did **not** restore portrait in the control experiment. Only a reload did.

This means the existing “reassert portrait if rotate overlay appears” logic at `:1390` actively makes the problem worse: it calls `_reassertPortrait()` → `setViewportSize()` → landscape, then waits for the overlay to disappear, which it cannot.

### RC-3: Share detection matches the rotate warning

`story-ui-selectors.js` `shareNames` includes `/add\s+to\s+your\s+story/i`. `_hasShareControl()` (`:1602`) checks both `getByRole('button', …)` and `getByText(name)`. The rotate warning is:

> “Rotate your device **to add to your story**.”

That substring matches the regex, so the warning text itself is accepted as the Share control. Live evidence showed `_hasShareControl === true` while the DOM contained only the warning `<p>` and `role="alert"`, and `share:button` was false.

### RC-4: “preview ready” has no stability or identity requirement

`_waitForPreviewReady()` (`:1367`) returns on the first poll where `_hasShareControl()` is true. It does not require:

- the control to be a real `button` with the exact accessible name,
- a bounding box in the bottom action bar,
- two consecutive stable polls,
- a visible preview canvas,
- the preview to match the uploaded file.

The real button is `BUTTON` with text `Add to your story`, `x=119, y=796, w=153, h=24`; the warning is a `<p>`/`role="alert"`. Shape and position are strong discriminators.

### RC-5: desktop Story entry is structurally impossible for this account

The mandated control is “top-header `+` immediately left of Notifications”. At 1280×800, Notifications is in the **left sidebar** (`y≈400`), and the only create control is the sidebar `svg[aria-label="Post"]`, which opens **Create new post**, not Story.

The current code still probes desktop first. That probe:

- fails with `notifications-not-in-header`,
- takes several `page.screenshot()` diagnostics (RC-1),
- then falls back to mobile and calls `setViewportSize` (RC-2).

The desktop path can never satisfy the requirement and should be removed as a Story route.

### RC-6: auth is checked before the first navigation

`publish()` calls `validateAccount()` at `:195` before `_navigateHome()` at `:218`. On a fresh storage-state page the URL is `about:blank`, so `detectAuthState()` returns `UNKNOWN` and the adapter returns `AUTH_REQUIRED` without ever loading Instagram. Live audit confirmed this ordering bug.

### RC-7: success is UI text only; uncertainty is not durable

`_awaitSuccess()` (`:1536`) confirms only on `successText`. It does not require independent evidence that the Story exists. Conversely, there is no durable write-ahead record before the single Share click:

- A crash between “click dispatched” and “result saved” leaves no way to distinguish “click never happened” from “click happened”.
- `_clickShareOnce()` iterates selectors; a click that dispatches but throws is treated as “not clicked”.
- In-memory `publishedKeys` is lost on restart; DB idempotency helps but does not encode “share may already have been invoked”.

### RC-8: diagnostics are neither isolated nor redacted

- Unit tests previously wrote into the live `data/diagnostics/story-ui/` directory; 1,176 files are mixed real/synthetic.
- No index, no retention, no correlation ID in filenames.
- JSON captures URLs, body snippets, DOM text; screenshots can include personal feed content or challenge pages.
- No explicit redaction pass for query tokens, emails, or session-like values.

### RC-9: failure taxonomy is incomplete

- `SHARE_FAILED` is returned with status `UNCERTAIN` for a missing Share control. That conflates “Share was never clicked” (safe, retryable) with “Share may have been clicked” (unsafe).
- `PREVIEW_TIMEOUT` is mapped to `SHARE_FAILED` when the reason is `rotate_overlay`, which hides the real cause.
- There is no `PUBLISH_FAILED` vs `PUBLICATION_UNCERTAIN` guarantee enforced by state, only by ad-hoc call sites.

---

## 6. Keep / fix / replace

### Keep

- Playwright and the single browser engine.
- `BrowserManager` modes (`existing`, `launch`, `storage-state`).
- Task queue, worker, scheduler, SQLite, content inbox, `story_details`, `publishing_history`.
- `ContentService.publishStoryFromMedia()` and the “exact file only” rule.
- `PublishingService` confirmation, dry-run, idempotency, `NEEDS_ATTENTION`, TTL.
- CLI framework (`parseContentArgs`, `openContentRuntime`, theme/JSON output).
- Diagnostics directory location (gitignored), but not its current implementation.
- The `StoryPublishState` vocabulary where it matches the new machine.

### Fix

- `story-ui-selectors.js`: remove the broad Share regex; add exact button matcher, bottom-bar geometry, rotate-warning exclusion.
- `_waitForPreviewReady`: require stable evidence + preview identity.
- `_awaitSuccess`: add independent verification; never confirm on transient text alone.
- `validateAccount` ordering: navigate first, then classify.
- Diagnostics: CDP screenshots, redaction, index, retention, test isolation.
- Failure taxonomy and persistence of share intent.
- `_isStoryUploadContext`: rotate overlay is a failure signal, not a ready signal.

### Replace / remove

- Desktop Story probe and adaptive surface selection. Story entry is **mobile-web portrait only**.
- `_shrinkWindowToPortrait()` (OS window resizing is unrelated to the actual flip and can fight the user’s desktop).
- Every `page.setViewportSize()` call in the Story path.
- Every `page.screenshot()` call in the Story path.
- Success-by-text-only.
- In-memory share-once guarantees as the primary safety mechanism.

---

## 7. Proposed architecture

```text
PlaywrightStoryPublishingAdapter (thin orchestrator)
  ├─ StoryPublishMachine            pure reducer + guards + transition table
  ├─ StoryBrowserSession            orientation-safe Playwright primitives
  │    ├─ applyPortrait()           CDP metrics only
  │    ├─ assertPortrait()          invariant check
  │    ├─ capture()                 CDP Page.captureScreenshot only
  │    ├─ reloadAndStabilize()      recovery for pre-entry flips
  │    └─ forbidden-primitive guard setViewportSize/screenshot never exposed
  ├─ StoryEntry                     plus resolution, menu verify, Story click
  ├─ StoryUpload                    chooser arming, setFiles, upload evidence
  ├─ StoryEditor                    readiness, exact Share control, geometry
  ├─ StoryMediaIdentity             in-page source↔preview fingerprint compare
  ├─ StoryPublicationVerifier       post-share signals + independent check
  ├─ StoryOperationStore            durable state, write-ahead share intent
  ├─ StoryDiagnostics               redacted CDP artifacts + index
  └─ story-ui-selectors             exact, testable selectors
```

### New / changed files

| File | Purpose |
| --- | --- |
| `src/modules/content/publishing/story/story-publish-machine.js` | Pure state machine, guards, transition table, timeout/failure-code registry |
| `src/modules/content/publishing/story/story-browser-session.js` | CDP-only portrait, invariant, CDP screenshots, reload recovery |
| `src/modules/content/publishing/story/story-entry.js` | Header `+` resolution + create menu + Story option + filechooser arming |
| `src/modules/content/publishing/story/story-upload.js` | `setFiles`, upload evidence, post-selection checks |
| `src/modules/content/publishing/story/story-editor.js` | Preview readiness, exact Share button, geometry, enabled state |
| `src/modules/content/publishing/story/story-media-identity.js` | Source→canvas fingerprint comparison |
| `src/modules/content/publishing/story/story-publication-verifier.js` | Success signals + profile/viewer independent verification |
| `src/modules/content/publishing/story/story-operation-store.js` | DB-backed operation lifecycle + recovery queries |
| `src/modules/content/publishing/story/story-diagnostics.js` | Redacted artifacts, index, retention, correlation IDs |
| `src/modules/content/publishing/playwright-story-adapter.js` | Orchestrator only; no raw selectors or orientation logic |
| `src/modules/content/publishing/story-ui-selectors.js` | Exact selectors and geometry constants |
| `src/modules/content/publishing/story-publish-states.js` | Expanded state list |
| `src/storage/migrations/004-story-operations.js` | `story_publish_operations` table |
| `src/cli/commands/story-inspect.js` | Inspect media without side effects |
| `src/cli/commands/story-validate.js` | Validate media + preflight + auth, no upload |
| `src/cli/commands/story-operation.js` | Show operation state/evidence/diagnostics |
| `src/cli/commands/story-recover.js` | Safe recovery: verify, never blind-retry |
| `tests/content/story/*` | Unit + integration + live-gated tests |

### `story_publish_operations` (migration 005; 004 is already Intelligence)

```sql
CREATE TABLE IF NOT EXISTS story_publish_operations (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  attempt_id TEXT,
  state TEXT NOT NULL,
  state_entered_at TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT 'mobile-web-portrait',
  media_path TEXT,
  media_checksum_sha256 TEXT,
  idempotency_key TEXT,
  share_intent_at TEXT,
  share_clicked_at TEXT,
  share_click_result TEXT,
  failure_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  diagnostics_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_ops_content ON story_publish_operations(content_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_ops_state ON story_publish_operations(state);
```

`share_intent_at` is written **before** the single Share click. Any crash after that timestamp is treated as `PUBLICATION_UNCERTAIN`, never as safe-to-retry.

---

## 8. Authoritative state machine

### 8.1 States

| State | Meaning |
| --- | --- |
| `INITIALIZING` | Adapter invoked; no browser action yet |
| `PREFLIGHT` | Media/config/auth prerequisites validated |
| `NAVIGATING_HOME` | Loading Instagram home |
| `AUTH_VERIFIED` | Authenticated chrome confirmed after navigation |
| `SURFACE_READY` | Portrait mobile invariant holds; no dialogs/rotate overlay |
| `CREATE_MENU_OPEN` | Verified header `+` clicked; Post + Story visible |
| `STORY_OPTION_VERIFIED` | Exact Story option with Post sibling and valid geometry |
| `FILECHOOSER_ARMED` | Listener registered **before** Story click |
| `STORY_OPTION_CLICKED` | Story click dispatched; waiting for chooser |
| `FILE_SELECTED` | `setFiles()` resolved |
| `EDITOR_LOADING` | `/create/story/` observed; Post composer absent |
| `EDITOR_READY` | Stable preview + exact enabled Share + identity match |
| `PRE_SHARE_SNAPSHOT` | Diagnostics captured; evidence frozen |
| `SHARE_ARMED` | Write-ahead intent persisted |
| `SHARE_INVOKED` | Single Share click dispatched (timestamped) |
| `POST_SHARE_OBSERVING` | Waiting for success + independent evidence |
| `PUBLICATION_CONFIRMED` | Evidence sufficient; Story verified |
| `PUBLICATION_UNCERTAIN` | Share may have been invoked; manual verification required |
| `PUBLISH_FAILED` | Share was never invoked; safe to retry |
| `ABORTED` | Operator abort; classified by whether Share was invoked |
| `AUTH_REQUIRED` | Human login needed |
| `CHECKPOINT_REQUIRED` | CAPTCHA/verification/challenge |

### 8.2 Transition table

| From | Event / guard | To | Timeout | Failure code |
| --- | --- | --- | --- | --- |
| `INITIALIZING` | content type is STORY, exactly one media file | `PREFLIGHT` | 5s | `PREFLIGHT_MEDIA_INVALID` |
| `PREFLIGHT` | file exists, MIME/size OK, checksum computed | `NAVIGATING_HOME` | 10s | `PREFLIGHT_MEDIA_INVALID` |
| `NAVIGATING_HOME` | home loaded without direct Story URL | `AUTH_VERIFIED` | 60s | `NAVIGATION_FAILED` |
| `AUTH_VERIFIED` | authenticated chrome + no challenge | `SURFACE_READY` | 15s | `AUTH_REQUIRED` / `CHECKPOINT_REQUIRED` |
| `SURFACE_READY` | portrait + no rotate overlay on 2 polls, 500ms apart | `CREATE_MENU_OPEN` | 10s | `ORIENTATION_NOT_PORTRAIT` |
| `CREATE_MENU_OPEN` | plus resolved left of Notifications; normal click; Post+Story visible | `STORY_OPTION_VERIFIED` | 8s | `HEADER_PLUS_NOT_FOUND` / `CREATE_MENU_STORY_MISSING` |
| `STORY_OPTION_VERIFIED` | exact Story button, Post sibling, in band, enabled | `FILECHOOSER_ARMED` | 3s | `STORY_OPTION_AMBIGUOUS` |
| `FILECHOOSER_ARMED` | listener registered before click | `STORY_OPTION_CLICKED` | 1s | `FILECHOOSER_ARM_FAILED` |
| `STORY_OPTION_CLICKED` | normal click; `filechooser` event | `FILE_SELECTED` | 10s | `FILECHOOSER_NOT_OPENED` |
| `FILE_SELECTED` | `chooser.setFiles()` resolves | `EDITOR_LOADING` | 30s | `FILE_INPUT_REJECTED` |
| `EDITOR_LOADING` | URL `/create/story/`, no Post composer, no challenge | `EDITOR_READY` | 60s | `EDITOR_NOT_OPENED` |
| `EDITOR_READY` | 2 stable polls + exact Share + canvas + fingerprint match | `PRE_SHARE_SNAPSHOT` | 15s | `ROTATE_OVERLAY_PRESENT` / `PREVIEW_IDENTITY_MISMATCH` |
| `PRE_SHARE_SNAPSHOT` | diagnostics written; evidence hash frozen | `SHARE_ARMED` | 5s | `DIAGNOSTICS_FAILED` (warn, continue) |
| `SHARE_ARMED` | DB write with `share_intent_at` succeeds | `SHARE_INVOKED` | 5s | `SHARE_INTENT_NOT_PERSISTED` |
| `SHARE_INVOKED` | click dispatched exactly once | `POST_SHARE_OBSERVING` | 5s | `SHARE_CLICK_AMBIGUOUS` → `PUBLICATION_UNCERTAIN` |
| `POST_SHARE_OBSERVING` | success signal + editor closed + profile story evidence | `PUBLICATION_CONFIRMED` | 45s | `SHARE_NOT_CONFIRMED` → `PUBLICATION_UNCERTAIN` |
| any pre-share | unrecoverable error / timeout / abort | `PUBLISH_FAILED` | — | specific code |
| any post-share | error / timeout / abort | `PUBLICATION_UNCERTAIN` | — | `PUBLICATION_UNCERTAIN` |
| any | login/challenge detected | `AUTH_REQUIRED` / `CHECKPOINT_REQUIRED` | — | `AUTH_REQUIRED` / `CHECKPOINT_REQUIRED` |

### 8.3 Invariants

1. Never call `page.setViewportSize()`.
2. Never call `page.screenshot()`; only CDP `Page.captureScreenshot`.
3. `screen.orientation.type === 'portrait-primary'` at `SURFACE_READY`, `EDITOR_READY`, and immediately before Share.
4. Never treat text containing “rotate your device” as a Share control.
5. Share is clicked at most once per operation ID.
6. After `SHARE_ARMED`, no automatic retry is allowed.
7. `PUBLISHED` requires independent evidence; UI toast alone is insufficient.
8. No direct `/create/story/` navigation.
9. Story entry is verified `+` → menu `Story` only.
10. All destructive actions require an explicit, per-attempt authorization flag.

---

## 9. Browser and entry strategy

### Chosen surface

**Mobile web portrait, 390×844, DPR 3**, via CDP:

```js
Emulation.setDeviceMetricsOverride({
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  screenWidth: 390, screenHeight: 844,
  screenOrientation: { type: 'portraitPrimary', angle: 0 },
})
Emulation.setUserAgentOverride({ userAgent: iPhone13.userAgent, platform: 'iPhone', ... })
Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })
```

- Set viewport once at context creation; never resize.
- Verify portrait after navigation, after dialog dismissal, after menu open, after upload, and before Share.
- If orientation is wrong **before the create menu opens**, reload (max 2) and re-stabilize. Reload is forbidden after file selection.
- No OS window resizing. It does not affect the emulated orientation and interferes with the user’s desktop.
- Use a visible browser for supervised attempts and dry-run validation; headless is acceptable for CI only.

### Entry sequence

1. Navigate to `https://www.instagram.com/` only.
2. Dismiss blocking dialogs.
3. Resolve `svg[aria-label in Notifications/Activity Feed/Activity]` with `top < 60`.
4. Resolve the candidate `<a href="#">`/button whose SVG path starts `M21 11h-8V3`, whose box is left of Notifications, excluding `aria-label="Plus icon"` and the home-house path.
5. Normal `click()` (no `force`, no JS `.click()`).
6. Require visible `Post` and `Story` options in the top band.
7. Register `filechooser` listener.
8. Click the exact `Story` option (normal click).
9. Require the `filechooser` event.

Why not desktop: the mandated header control does not exist in the desktop layout; the sidebar `Post` control is a different surface and opens Create new post. Treat desktop as unsupported for Story, not as a fallback.

---

## 10. Upload verification

`setFiles()` resolving is **not** proof of upload. Required evidence:

| Check | Method | Pass condition |
| --- | --- | --- |
| Chooser was armed before click | state flag + timestamps | `FILECHOOSER_ARMED` before `STORY_OPTION_CLICKED` |
| Chooser received | Playwright event | event object, `isMultiple()` recorded |
| File attached | `setFiles()` resolved | no exception, timestamp |
| Editor navigation | URL | `/create/story/` and not `/create/select/` or Post composer |
| No Post composer | DOM | no “Create new post” / “Drag photos and videos here” |
| Preview surface | DOM | visible `canvas` ≥ 720×1280, or visible blob/data image |
| Preview identity | fingerprint | source vs canvas 16×16 RGB distance below threshold |
| Editor chrome | DOM | `Close` and `Add AI label` visible |
| Share action | DOM | exact `button` “Add to your story”, enabled, bottom band |
| Orientation | `screen.orientation.type` | `portrait-primary` |
| No rotate overlay | DOM text + element shape | false |

If any check fails before Share, the result is `PUBLISH_FAILED` with the specific code, and the operation is retryable.

---

## 11. Preview and identity verification

The real editor exposes three `1170×2532` canvases and no blob `<img>` elements. To prove the preview is the uploaded file:

1. Read the source file as base64 in Node.
2. In the page, decode it via `new Image()` + data URL.
3. Draw both the source image and the dominant editor canvas to a 16×16 offscreen canvas.
4. Compute an RGB fingerprint for each (64 values).
5. Compare with mean absolute error and per-channel tolerance.

This is implemented without extra dependencies. It also proves:

- the upload was decoded by Instagram,
- the editor is showing image content, not an empty/error state,
- the file was not swapped or rejected.

Store both fingerprints and the distance in the operation evidence. A mismatch is `PREVIEW_IDENTITY_MISMATCH`, never `READY_TO_SHARE`.

---

## 12. Publication, idempotency, independent verification, recovery

### Share once

- `share_intent_at` is written to `story_publish_operations` **before** click.
- The click targets the exact `button` with accessible name `Add to your story`, enabled, box in the bottom action bar.
- The click is attempted once. If the locator resolves and `click()` returns, `share_clicked_at` is written.
- If `click()` throws after dispatch is possible (navigation, detach, timeout), classify `PUBLICATION_UNCERTAIN`, not failure.

### Evidence ladder

| Level | Evidence | Sufficient for `PUBLISHED`? |
| --- | --- | --- |
| V1 | Success toast/dialog text | No |
| V2 | Editor closed / returned to feed | No |
| V3 | Own profile shows an active Story ring, with before/after comparison | Yes, if V1+V2+V3 |
| V4 | Open own Story viewer and fingerprint-match the displayed media | Yes, strongest |
| V5 | Manual operator confirmation recorded via CLI | Yes, with operator ID |

V4 requires viewing “Your story”. The creation ban on the Story tray remains in force; viewing for verification must be an explicit, separately authorized step. Default to V3; offer V4 behind `--verify-viewer` with owner approval.

### Outcomes

- `PUBLISHED`: V1 + V2 + (V3 or V4/V5).
- `PUBLICATION_UNCERTAIN`: Share may have been invoked but evidence is incomplete. Content → `NEEDS_ATTENTION`. No retry.
- `PUBLISH_FAILED`: Share was never invoked. Content → `FAILED`. Retry allowed after operator action.

### Recovery CLI

```bash
npm run story:operation -- <operation-id> [--json]
npm run story:recover -- <operation-id> --verify [--json]
npm run story:recover -- <operation-id> --mark-failed --reason "not on profile after 10m"
```

`story:recover --verify`:

1. Refuses if `share_intent_at` is null (nothing to recover).
2. Opens the profile, checks for an active Story ring.
3. Optionally opens the viewer with `--verify-viewer`.
4. If found → `PUBLISHED` with evidence.
5. If not found → wait for a configurable propagation window (default 5 minutes), re-check once.
6. Still not found → require explicit `--mark-failed`; never auto-retry.

---

## 13. Diagnostics and security

### Requirements

- One directory per operation: `data/diagnostics/story-ui/<operation-id>/`.
- Index file with state timeline, selectors, match counts, boxes, URLs, filechooser evidence, upload evidence, preview fingerprints, console errors.
- Screenshots via CDP only.
- No cookies, tokens, passwords, storage-state content, or `sessionid`.
- Redact query strings and fragment tokens from URLs.
- Skip/redact challenge pages and login forms; never screenshot credentials.
- Retention: keep last N operations (default 20), delete older.
- Tests use a temp directory and never write to the live one.
- Logs use operation ID, task ID, content ID, attempt ID; no media bytes.

### Artifact schema (example)

```json
{
  "operationId": "op_...",
  "taskId": "task_...",
  "contentId": "content_...",
  "attemptId": "attempt_...",
  "surface": "mobile-web-portrait",
  "stateTimeline": [{ "state": "SURFACE_READY", "at": "...", "details": {} }],
  "entry": { "plusBox": {}, "notifBox": {}, "menuOptions": [] },
  "fileChooser": { "armedAt": "...", "receivedAt": "...", "multiple": false },
  "upload": { "setFilesAt": "...", "url": "/create/story/" },
  "preview": { "canvas": { "w": 1170, "h": 2532 }, "fingerprint": [], "distance": 0.7 },
  "share": { "intentAt": "...", "clickedAt": "...", "box": {}, "enabled": true },
  "verification": { "signals": [], "profileStory": true, "viewerMatch": null },
  "consoleErrors": [],
  "failureCode": null
}
```

---

## 14. Test plan

### Unit (pure, no browser)

- Every transition and guard in the machine.
- Every timeout and failure code.
- Selector matchers: exact Share button; rotate warning excluded; ambiguous matches rejected.
- Geometry rules for header `+`, menu band, bottom action bar.
- Fingerprint comparator thresholds.
- Diagnostics redaction.
- Operation store: write-ahead ordering, recovery queries, no-retry-after-share.

### Browser integration (local fixture page)

- Fixture mimics the live DOM shape: header `+`, Notifications, Post/Story menu, filechooser, editor canvases, exact Share button.
- Assert the flow reaches `EDITOR_READY` and **never** calls `setViewportSize` or `page.screenshot`. Instrument a proxy page to fail the test if either is called.
- Simulate orientation flip and assert recovery only before file selection.
- Simulate rotate warning and assert it is never accepted as Share.
- Simulate preview identity mismatch and assert `PREVIEW_IDENTITY_MISMATCH`.

### Live-gated tests (explicit opt-in)

- `STORY_LIVE=1` + authenticated storage state.
- `story:validate`: open home, stabilize portrait, open create menu, stop before Story click.
- `story:dry-run`: full path through `EDITOR_READY`, capture evidence, cancel without Share.
- Supervised publish: only with a dedicated flag and a unique test image; stop on `PUBLICATION_UNCERTAIN`; run `story:recover --verify`.

### Regression suite

- `npm test` remains green.
- New tests must fail against the old adapter (orientation and Share false positive).
- No live diagnostics written by tests.
- SQLite migration idempotency.

---

## 15. Ordered implementation phases

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 0 | Freeze and clean: quarantine old Story paths, isolate diagnostics, add migration 005 skeleton | tests green; no live dir writes |
| 1 | Pure state machine + transition table + failure codes | unit coverage of all transitions |
| 2 | `StoryBrowserSession`: CDP portrait, invariant, CDP capture, reload recovery | forbidden-primitive test passes |
| 3 | `StoryEntry`: header `+`, menu, Story option, filechooser arming | live reaches `STORY_OPTION_CLICKED` |
| 4 | `StoryUpload` + `StoryEditor` + identity fingerprint | live reaches `EDITOR_READY` in portrait |
| 5 | `StoryOperationStore`: write-ahead share intent + recovery | crash simulation yields `UNCERTAIN` |
| 6 | `StoryPublicationVerifier`: V1–V3 evidence | live dry-run evidence valid |
| 7 | Diagnostics/redaction/CLI (`inspect`, `validate`, `operation`, `recover`) | CLI contract tests |
| 8 | Full test suite, diff review, security review | 100% tests, no secrets in diff/logs |
| 9 | Supervised real publish | only after explicit per-attempt authorization |

Phases 0–8 are safe and do not publish. Phase 9 is a separate authorization gate.

### Implementation status (Phases 0–4, 2026-11-19)

Implemented and exercised live:

- `story/story-states.js` + `story/story-publish-machine.js`: canonical states, explicit transition table, per-state timeouts, failure codes, and deterministic `PUBLISH_FAILED` vs `PUBLICATION_UNCERTAIN` classification. No browser or database side effects.
- `story/story-browser-session.js`: CDP-only portrait metrics, orientation invariant, reload-before-entry recovery, and CDP diagnostics capture. The Story path never calls `page.screenshot()` or `page.setViewportSize()`.
- `story/story-entry.js`: verified header Create (+) (`path=d^"M21 11h-8V3"`, immediately left of Notifications), Post/Story menu, and a native `filechooser` listener registered before the Story click. The exact Story row is selected by its own trimmed text and clicked through Playwright (no JS `.click()`, no force-click).
- `story/story-upload.js` + `story/story-editor.js` + `story/story-media-identity.js`: chooser upload, `/create/story/` verification, 1170×2532 preview canvas, exact enabled “Add to your story” native button in the bottom bar, and a CDP clip identity fingerprint.
- `story/story-diagnostics.js`: one directory per operation, CDP screenshots only, URL/text redaction, retention pruning.
- Migration `005-story-operations` (004 is already Intelligence). The durable operation store and recovery wiring remain Phase 5.
- The adapter now hard-codes `dryRunOnly: true` and `publicationEnabled: false`. PublishingService also treats `dryRunOnly` as a hard gate, so passing `dryRun: false` cannot promote the adapter.

Live evidence (two fresh consecutive dry-runs in this session, plus four earlier runs during implementation; no Share):

- Reached `DRY_RUN_COMPLETE` at the real editor.
- `screen.orientation.type = portrait-primary` before upload, at editor readiness, and after the CDP identity capture.
- Header + box left of Notifications; menu `Post` + `Story`; upload via native `filechooser`.
- Share box `{x:119, y:796, width:153, height:24}`; identity distance `5.45` (threshold 24); `0` Share clicks observed; `0` forbidden API calls.
- Logs: `data/diagnostics/phase04-evidence/live-01.log` and `live-02.log`; per-stage diagnostics under `data/diagnostics/phase04-evidence/<run>/diagnostics/` (gitignored).

Not implemented in this phase: durable share-intent wiring, post-Share observation/verification, diagnostics CLI (`inspect`, `operation`, `recover`), and supervised real publication.

---

## 16. Risks and open questions

1. **Instagram UI drift.** The verified DOM is a snapshot. Selectors must be treated as evidence-backed and re-validated live before each release.
2. **Orientation flips from unknown sources.** We proved `page.screenshot()` and `setViewportSize()`; other APIs may also reset metrics. Mitigate with the invariant and a pre-Share assertion, not with reassert loops that use forbidden primitives.
3. **Profile Story evidence may be delayed or unavailable.** V3 may be flaky. Decide whether V4 (open own viewer) is permitted for verification. This is the main open product decision.
4. **Existing active Story.** If the account already has a Story, a profile ring is not specific to the new upload. Use before/after comparison and/or viewer fingerprint.
5. **Browser mode.** The user’s CDP `existing` Chrome currently fails with `REMOTE_DEBUGGING_DISABLED`. Production should use `storage-state` or a dedicated persistent profile. Decide and document; do not change the user’s profile.
6. **Diagnostics privacy.** Feed screenshots can contain personal content. Retention and redaction policy needs sign-off.
7. **Share confirmation dialog.** If Instagram adds a second confirmation, the machine must handle it without a second Share click.
8. **PNG support.** The docs claim PNG is supported for browser Stories; live validation should confirm the editor accepts it and preserves dimensions.
9. **Media archival.** A confirmed success moves the file to `published/`; an uncertain result leaves it pending. Verify this on the real flow, not only in tests.
10. **Authorization wording.** Real publish must require an unambiguous per-attempt flag, not just `--confirm`, because `--confirm` also exists for dry-run/enqueue.

---

## 17. Authorization and next step

No real Story has been published during this audit. The working live probe stopped at `EDITOR_READY` and did not click **Add to your story**.

Recommended next step after approval of this plan:

1. Implement Phases 0–4 (state machine, orientation-safe session, entry, upload, editor readiness).
2. Run `story:validate` and `story:dry-run` live; attach the evidence bundle.
3. Review the diff and test results with the owner.
4. Request a separate, explicit authorization for one supervised real publication.
5. Publish once, then run independent verification and `story:recover --verify` if evidence is incomplete.

Until that authorization is given, all work remains dry-run / no-Share.

---

## Appendix A — Evidence index

| Evidence | Location |
| --- | --- |
| Orientation control experiment | `/tmp/opencode/screenshot-orientation.log` |
| Working full flow (CDP screenshots only) | `/tmp/opencode/fixed-flow-probe2.log` |
| Working editor JSON | `/tmp/opencode/fixed-flow-probe2/editor-evidence.json` |
| Working editor screenshot | `/tmp/opencode/fixed-flow-probe2/05-final.png` |
| Earlier failing flow | `/tmp/opencode/fixed-flow-probe.log` |
| Manual failing repro | `/tmp/opencode/manual-story2.log` |
| Phase 0–4 live dry-runs (6/6; latest 2/2 persistent) | `data/diagnostics/phase04-evidence/live-01.log`, `live-02.log` |
| Phase 0–4 live diagnostics | `data/diagnostics/phase04-evidence/<run>/diagnostics/` |
| Real DB attempts | `data/bot.sqlite` → `publishing_history` |
| Current diagnostics pollution | `data/diagnostics/story-ui/` (1,176 files) |

## Appendix B — Exact live DOM (verified)

- Header create: `<a href="#">` containing `svg path[d^="M21 11h-8V3"]`, immediately left of Notifications.
- Menu: `[role="dialog"] div[role="button"]` with text `Post`, `Story`.
- Story click: native Playwright `filechooser`.
- Editor URL: `https://www.instagram.com/create/story/`.
- Editor body text: `Close`, `Add AI label`, `Add to your story`.
- Share control: `BUTTON`, accessible name `Add to your story`, box `{x:119,y:796,w:153,h:24}`, enabled.
- Preview: three canvases `1170×2532`, first with class `_aa3c`.
- Rotate warning: `<p>` and `<div role="alert">` containing “Rotate your device to add to your story.”
