# Browser-based Instagram Story publishing

Phase 1 publishes Stories through the existing Playwright browser session.
It does **not** use the Instagram Graph API.

## Media directory

Recommended operator inbox (`STORY_MEDIA_DIR`, default `./media/stories`):

```text
media/stories/
  pending/      # drop images here
  published/    # relocated after confirmed success
  failed/       # relocated after confirmed failure
```

Create it explicitly (nothing is auto-created on startup):

```bash
npm run media:init
```

The content library at `data/media/` remains the immutable import store used by Content Manager. Inbox files are copied into that library when a Story draft is created; originals are later relocated from `pending/` only after a confirmed success or failure.

## Supported image formats

| Format | Browser Story publish | Graph Story publish |
| --- | --- | --- |
| JPEG | yes | yes |
| PNG | yes | no (Meta Story image spec) |
| Other | no | no |

Phase 1 browser publishing is **image-only**. Videos are rejected by `story:publish`.

## CLI

```bash
npm run media:init
npm run media:list
npm run media:inspect -- story-01.jpg

# Dry-run (no Share click / mock adapter)
npm run story:publish -- story-01.jpg --confirm --dry-run

# Real publish (engine must be running)
# PUBLISHING_ADAPTER=playwright
# CONTENT_DRY_RUN=false
npm start   # separate terminal
npm run story:publish -- story-01.jpg --confirm

npm run story:status
npm run jobs
```

`npm run agent` remains the Intelligence Core CLI and does not route Story media commands.

## Workflow

1. Owner places an image in `media/stories/pending/`
2. `media:list` / `media:inspect` validate the exact file
3. `story:publish <exact-name> --confirm` creates a Story draft, approves it, and enqueues `content.publish` (`maxAttempts: 1`)
4. The running engine’s Playwright adapter:
   - Checks browser + auth health
   - Stops on checkpoint / CAPTCHA / verification (human intervention)
   - Opens Story creation, uploads the exact local file, waits for preview
   - Clicks Share only when not dry-run
   - Requires a success signal — Share click alone is not enough
5. Results persist in `publishing_history` + Story details; uncertain outcomes become `NEEDS_ATTENTION`

## Session requirements

- Authenticated Instagram session via existing BrowserManager mode (`existing` / `launch` / `storage-state`)
- Engine running (`npm start`) for real Playwright publishes
- Do not bypass Instagram security checks

## Failure handling

| Outcome | Content status | Media file | Action |
| --- | --- | --- | --- |
| SUCCEEDED | `PUBLISHED` | moved to `published/` | Done |
| FAILED | `FAILED` | moved to `failed/` | Fix and re-drop a new copy if needed |
| UNCERTAIN | `NEEDS_ATTENTION` | left in `pending/` | Verify Instagram manually; do **not** blind-retry |
| DRY_RUN | stays approved | left in place | Safe rehearsal |
| Checkpoint / CAPTCHA | `NEEDS_ATTENTION` | left in place | Complete challenge in browser |

Duplicate publishes are blocked by content idempotency keys and `maxAttempts: 1` on publish tasks.

## Inspecting results

```bash
npm run story:status
npm run story:status -- <story-id> --json
npm run story:history -- <story-id>
npm run jobs -- --verbose
```

Automated tests never publish to a real Instagram account. Real-browser smoke tests are opt-in and must stop before Share unless you explicitly authorize a live publication.
