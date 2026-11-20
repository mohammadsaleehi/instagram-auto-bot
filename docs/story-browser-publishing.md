# Browser-based Instagram Story publishing

Phases 0–4 implement the mobile-web portrait Story path through a **verified
editor**, without publishing. It does **not** use the Instagram Graph API and it
does **not** click **Add to your story** yet.

The adapter is intentionally `dryRunOnly: true` and reports
`publicationEnabled: false`. Even `story:publish --confirm` without `--dry-run`
stops at `EDITOR_READY` and persists a `DRY_RUN`. Real publication is a separate
Phase 9 authorization gate.

## Media directory

Recommended operator inbox (`STORY_MEDIA_DIR`, default `./media/stories`):

```text
media/stories/
  pending/      # drop images here
  published/    # relocated after confirmed success (future)
  failed/       # relocated after confirmed failure
```

Create it explicitly (nothing is auto-created on startup):

```bash
npm run media:init
```

The content library at `data/media/` remains the immutable import store used by
Content Manager. Inbox files are copied into that library when a Story draft is
created; originals are relocated from `pending/` only after a confirmed success
or failure.

## Supported image formats

| Format | Browser Story editor (Phases 0–4) | Graph Story publish |
| --- | --- | --- |
| JPEG | yes | yes |
| PNG | yes (live editor accepts it) | no (Meta Story image spec) |
| Other | no | no |

The browser path accepts JPEG and PNG. Videos are rejected by `story:publish`.

## CLI

```bash
npm run media:init
npm run media:list
npm run media:inspect -- story-01.jpg

# Safe rehearsal: entry + upload + editor readiness, no Share.
npm run story:publish -- story-01.jpg --confirm --dry-run

# The engine must be running for the Playwright adapter.
# PUBLISHING_ADAPTER=playwright
npm start   # separate terminal
npm run story:publish -- story-01.jpg --confirm

npm run story:status
npm run jobs
```

In Phases 0–4 the second command is still a dry-run at the adapter boundary; it
verifies the real editor and stops before Share. Do not interpret `--confirm`
alone as authorization to publish.

`npm run agent` remains the Intelligence Core CLI and does not route Story media
commands.

## Workflow

1. Owner places an image in `media/stories/pending/`.
2. `media:list` / `media:inspect` validate the exact file.
3. `story:publish <exact-name> --confirm` creates a Story draft, approves it, and
   enqueues `content.publish` (`maxAttempts: 1`).
4. The running engine’s Playwright adapter:
   - Creates a CDP session and applies iPhone 13 portrait metrics (390×844, DPR 3).
   - Navigates to Instagram **home**, waits for the page to initialize, then
     classifies authentication. Auth is never evaluated on `about:blank`.
   - Dismisses ordinary dialogs and restores portrait by reload only if needed.
   - Clicks the verified top-header Create (+) immediately left of Notifications
     (`svg path[d^="M21 11h-8V3"]`).
   - Verifies the Post/Story creation menu and selects the exact **Story** row.
   - Registers the native `filechooser` listener **before** clicking Story.
   - Uploads exactly one local file with `setFiles()`.
   - Waits for `/create/story/` and the real 1170×2532 preview canvas.
   - Requires one visible, enabled native **Add to your story** button whose own
     trimmed text is exact and whose box is in the bottom action bar.
   - Verifies the preview identity by capturing the canvas clip through CDP
     `Page.captureScreenshot` and comparing a 16×16 fingerprint with the source.
   - Requires two consecutive stable observations.
   - Stops at `EDITOR_READY` / `DRY_RUN_COMPLETE`; **Share is not clicked**.
5. Results persist in `publishing_history`; the Story operation skeleton lives in
   `story_publish_operations` (migration 005). Uncertain outcomes (future
   post-Share phase) become `NEEDS_ATTENTION`.

## Orientation rules

- Portrait is applied **only** through CDP `Emulation.setDeviceMetricsOverride`.
- `page.setViewportSize()` and `page.screenshot()` are forbidden in the Story
  path; both were proven to flip `screen.orientation.type` to
  `landscape-primary`.
- Diagnostics screenshots use CDP `Page.captureScreenshot`.
- A reload may restore portrait **before** Story entry. After upload, a flipped
  orientation fails closed with `ORIENTATION_NOT_PORTRAIT`; the editor is never
  “ready” in landscape.
- The invariant is checked before entry, at editor readiness, and after the CDP
  identity capture.

## Entry rules

Allowed:

- Top-header Create (+) immediately left of Notifications.
- Post/Story menu → exact Story row.
- Native filechooser.

Never allowed for Story creation:

- Profile avatar, “Your story”, the Story tray, or avatar badge.
- Direct `/create/story/` navigation.
- `force: true` clicks, JS `.click()`, or feed hidden file inputs.
- Treating Create new post / Reel as Story publishing.
- Treating `setFiles()` resolving, a URL change, a text match, or a rotate
  warning as proof of upload/publication readiness.

## Readiness contract

`EDITOR_READY` requires all of:

- URL `/create/story/`
- `screen.orientation.type === 'portrait-primary'`
- no rotate-device warning
- no Create-new-post composer
- visible canvas with backing ≥ 720×1280
- exactly one enabled native “Add to your story” button in the bottom bar
- preview identity distance below threshold (live: 5.45; threshold 24)
- the same geometry on two consecutive polls

## Diagnostics

Each operation gets `data/diagnostics/story-ui/<operation-id>/`:

- CDP PNG screenshots
- DOM summary: URL, viewport, orientation, body snippet, file inputs, canvases,
  share candidates, dialog count
- failure code/message
- `index.json` with stages and timestamps

URLs are stripped of query/fragment tokens and text is redacted. Cookies,
storage state, passwords, and tokens are never written. Unit and browser tests
use temporary directories.

## Failure handling

| Outcome | Content status | Media file | Action |
| --- | --- | --- | --- |
| SUCCEEDED (future post-Share) | `PUBLISHED` | moved to `published/` | Done |
| FAILED (pre-Share) | `FAILED` | moved to `failed/` | Fix and re-drop a new copy if needed |
| UNCERTAIN (post-Share only) | `NEEDS_ATTENTION` | left in `pending/` | Verify Instagram manually; do **not** blind-retry |
| DRY_RUN | stays approved | left in place | Safe rehearsal |
| Checkpoint / CAPTCHA | `NEEDS_ATTENTION` | left in place | Complete challenge in browser |

Duplicate publishes are blocked by content idempotency keys and `maxAttempts: 1`
on publish tasks.

## Session requirements

- Authenticated Instagram session via the existing BrowserManager mode
  (`existing` / `launch` / `storage-state`).
- For live dry-runs in this environment, `storage-state` with
  `data/instagram-auth.json` is the working mode; the personal Chrome CDP mode is
  unavailable while remote debugging is disabled.
- Engine running (`npm start`) for Playwright Story operations.
- Do not bypass Instagram security checks. A checkpoint or CAPTCHA stops the
  operation and requires human completion.

## Tests

- `tests/content/story/story-publish-machine.test.js`: pure transitions and
  `PUBLISH_FAILED` vs `PUBLICATION_UNCERTAIN`.
- `tests/content/story/story-browser-integration.test.js`: real Chromium + local
  Story fixture, CDP orientation preservation, native filechooser, editor
  readiness, rotate/text-only rejection, identity mismatch, landscape failure.
- `tests/content/story/story-adapter-phase04.test.js`: end-to-end adapter pass
  with `page.screenshot`/`setViewportSize` patched to throw, plus phase-gate and
  Share-count assertions.
- `tests/content/playwright-story-adapter.test.js`: preflight, direct-URL ban,
  and auth-after-navigation unit coverage.
- `tests/content/publishing-service-dry-run-gate.test.js`: a `dryRunOnly`
  adapter cannot be promoted with `dryRun: false`.
- `tests/content/migration-005.test.js`: operation table and indexes.

Live dry-runs are supervised and opt-in. They stop at the verified editor unless
a separate per-attempt authorization is given.

## Inspecting results

```bash
npm run story:status
npm run story:status -- <story-id> --json
npm run story:history -- <story-id>
npm run jobs -- --verbose
```

Automated tests never publish to a real Instagram account. Real-browser smoke
tests must stop before Share unless you explicitly authorize a live publication.
