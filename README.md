# Instagram Auto Bot

Single-account Instagram automation engine built with **JavaScript (ES Modules)**, **Node.js ≥ 22.5**, **Playwright**, and a **persistent SQLite task queue** (`node:sqlite`).

By default the bot attaches to your already-running Google Chrome instance over CDP, authenticates to Instagram, then runs a durable automation engine (queue, worker, scheduler, health monitoring, local runtime controls).

## What it does today

- Detect an existing Instagram session in personal Chrome (CDP)
- Perform automatic login when credentials are configured
- Wait for manual 2FA / checkpoint / CAPTCHA completion
- Provision Instagram-only Playwright storage state with `npm run login`
- Optionally reuse that state on a server with `BROWSER_MODE=storage-state`
- Persist tasks across restarts in SQLite
- Execute registered task handlers with retries, pause/resume, and graceful shutdown
- Expose local operator commands: `status`, `pause`, `resume`, `jobs`, `doctor`
- Manage content drafts, media, approvals, schedules, and publishing history for one account
- Manage and publish Instagram Stories (IMAGE / VIDEO) through the same Content Manager
- Publish Stories through Playwright browser automation (Phase 1), a mock adapter (dev/test), or optionally the official Instagram Graph Content Publishing API

No mass following/liking, bulk unsolicited messaging, scraping of other users' personal data, CAPTCHA bypass, anti-detection features, or Instagram Highlights automation are implemented.

## Architecture

```text
src/
  core/           Application lifecycle, event bus, error sanitization
  tasks/          Persistent queue, worker, registry, recovery, demo handler
  scheduler/      Persistent schedules (one-shot + interval) with catch-up policy
  execution/      Retry/backoff, concurrency (=1), idempotency helpers
  monitoring/     Session + system health
  storage/        SQLite database, migrations, repositories
  adapters/       Browser + Instagram adapters (handlers never own lifecycle)
  ipc/            Local Unix-domain control socket (user-only permissions)
  cli/commands/   status / pause / resume / jobs / doctor / content:* / story:*
  auth/           Existing login + storage-state (unchanged contract)
  browser/        Existing BrowserManager (unchanged contract)
  modules/content Content drafts, Stories, media, approval, publishing adapters
```

**Separation of concerns**

| Layer | Responsibility |
| --- | --- |
| Browser / auth | Connect, login, detect auth, persist storage-state |
| Adapters | Give handlers a page/context + auth checks without owning Chrome/DB |
| Task engine | Durable queue, claim, execute, retry, recover |
| Scheduler | Decide *when* to enqueue; never executes Instagram work itself |
| IPC / CLI | Operator control from another terminal |

Future Instagram feature modules must implement the shared task-handler interface and must not manage browser or database lifecycle. Prefer official Instagram Platform APIs for supported business/creator capabilities.

## Installation

```bash
npm install
cp .env.example .env
```

Requires Node.js **22.5+** (for built-in `node:sqlite`) and Google Chrome.

Enable remote debugging before the default CDP mode:

1. Open Chrome
2. Go to `chrome://inspect/#remote-debugging`
3. Enable **Allow remote debugging for this browser instance**

## Configuration

Important engine defaults (see `.env.example` for the full list):

```env
BROWSER_MODE=existing
AUTO_LOGIN=true
APP_TIMEZONE=Europe/Berlin
WORKER_CONCURRENCY=1
TASK_MAX_ATTEMPTS=3
TASK_RETRY_BASE_MS=5000
TASK_RETRY_MAX_MS=300000
TASK_STALE_TIMEOUT_MS=60000
TASK_SHUTDOWN_TIMEOUT_MS=30000
DATABASE_PATH=./data/bot.sqlite
AUTH_STORAGE_STATE_PATH=./data/instagram-auth.json
CONTROL_SOCKET_PATH=./data/bot.sock
```

Invalid values are rejected (not silently coerced). Existing user `.env` files are never overwritten by the project.

## Database

- Default path: `./data/bot.sqlite` (gitignored)
- Schema versioning via `schema_migrations` (Phase 2 `001-initial`, content `002-content`)
- Content tables: `content_items`, `content_media`, `content_approvals`, `publishing_history`
- WAL mode, foreign keys, user-only file permissions (`0600`) when possible
- `data/` directory should remain `0700`

### Backup

```bash
# Stop the bot first (or at least pause heavy writes)
npm run pause   # optional
cp data/bot.sqlite "backup/bot-$(date +%F).sqlite"
# Also copy WAL/SHM if present and the process was not stopped cleanly:
# cp data/bot.sqlite-wal data/bot.sqlite-shm backup/
```

### Restore

```bash
# Stop the bot
cp backup/bot-YYYY-MM-DD.sqlite data/bot.sqlite
chmod 600 data/bot.sqlite
npm start
```

## Task lifecycle

Statuses: `PENDING` → `RUNNING` → `COMPLETED` | `FAILED` | `CANCELLED` | `NEEDS_ATTENTION`

1. Enqueue (API/scheduler) with optional `idempotency_key`
2. Worker claims transactionally (`BEGIN IMMEDIATE`)
3. Health + auth checks run before handler execution
4. Handler returns a sanitized result, or throws a classified error
5. Retryable failures use exponential backoff + jitter (and Retry-After when present)
6. Non-retryable auth/verification failures pause auth-dependent work
7. After a crash: stale `RUNNING` tasks without side effects return to `PENDING`; uncertain external side effects become `NEEDS_ATTENTION` (never blind replay)

Demo handler (no Instagram side effects): `engine.health-check`.

Content publishing handler: `content.publish` (registered by the content module; uses the Phase 2 queue — no second scheduler).

## Content management

Phase 3.1 adds a single-account content lifecycle on top of the existing task engine and SQLite database.

### Architecture

```text
src/modules/content/
  content-manager.js          wiring / factory
  content-service.js          drafts, approval, schedule, cancel
  content-repository.js       content_items / media / approvals / history
  media-manager.js            local media library + magic-byte validation
  caption-manager.js          caption/hashtag helpers (no auto-claims)
  content-state-machine.js    status transitions
  publishing/
    publishing-adapter.js     Mock + Official Instagram Graph adapters
    publishing-service.js     idempotent publish + history + task handler
    publishing-validator.js   approval / confirm guards
```

### Draft lifecycle

```text
DRAFT → READY_FOR_REVIEW → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED
                         ↘ REJECTED
Editing APPROVED / SCHEDULED content invalidates approval and returns to DRAFT.
Additional states: FAILED, NEEDS_ATTENTION, CANCELLED
Stories only: PUBLISHED → EXPIRED (after ~24h)
```

### Media storage

- Library directory: `MEDIA_LIBRARY_DIR` (default `./data/media`, gitignored)
- MIME detection uses magic bytes (extensions are never trusted alone)
- Feed defaults: JPEG/PNG images, MP4/MOV video
- Story images: JPEG only (Meta Story Image Specifications)
- Story videos: MP4/MOV, 3–60 seconds, ≤100 MB (Meta Story Video Specifications)
- Duplicate assets are detected by SHA-256 checksum
- Original uploads are never modified; optional ffprobe enriches video preview metadata when available
- Media files are never executed

### Approval workflow

- Content must be explicitly approved before scheduling or publishing
- Approvals record actor + timestamp in `content_approvals`
- Immediate publish requires `--confirm` (unless dry-run)
- Editing approved content records `INVALIDATE` and clears the schedule
- Stories do not require captions (unsupported by the public Story publishing API)

### Publishing adapters

| Adapter | Purpose | Real Instagram post? |
| --- | --- | --- |
| `mock` (default) | Development and automated tests | **No** — results are always labeled simulated |
| `instagram-graph` | Official Meta Graph Content Publishing API | Only when configured, not dry-run, and Graph publish succeeds |

```env
PUBLISHING_ADAPTER=mock
CONTENT_DRY_RUN=true
MEDIA_LIBRARY_DIR=./data/media

# Official API (Instagram Professional account):
# PUBLISHING_ADAPTER=instagram-graph
# CONTENT_DRY_RUN=false
# INSTAGRAM_GRAPH_ACCESS_TOKEN=...
# INSTAGRAM_BUSINESS_ACCOUNT_ID=...
# INSTAGRAM_GRAPH_LOGIN_FLOW=facebook   # or instagram
# MEDIA_PUBLIC_BASE_URL=https://cdn.example.com/media
```

Official Graph publishing requirements (see Meta docs):

- Instagram Professional account (Business or Creator) — personal accounts are not eligible
- Choose **one** authentication model and do not mix hosts/tokens/permissions:
  - Facebook Login → `graph.facebook.com` + `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
  - Instagram Login → `graph.instagram.com` + `instagram_business_basic`, `instagram_business_content_publish`
- Publicly reachable HTTPS media URLs for container creation (`MEDIA_PUBLIC_BASE_URL` must serve `MEDIA_LIBRARY_DIR`)
- Valid non-expired access token for the selected login flow

If Graph credentials are missing, the official adapter stays in dry-run mode. Simulated / dry-run publications are **never** labeled as real Instagram publications (`realInstagramPublication=false`).

### Scheduling examples

Default timezone: `Europe/Berlin` (`APP_TIMEZONE`).

```bash
# Create a draft (non-interactive)
npm run content:create -- --title="Launch" --type=IMAGE --caption="Hello" --media=./photo.jpg --hashtags=launch,news

# Approve
npm run content:approve -- <content-id> --actor=alice

# Schedule for a specific time
npm run content:schedule -- <content-id> --at="2026-11-11T10:00:00+01:00"

# Immediate dry-run publish via the Phase 2 task queue
npm run content:schedule -- <content-id> --now --confirm --dry-run

# Cancel
npm run content:cancel -- <content-id>

# History / calendar
npm run content:history -- <content-id>
npm run content:list -- --calendar
```

Schedules reuse the Phase 2 `schedules` table and enqueue `content.publish` when due. After process restarts, due schedules are picked up without duplicate enqueue thanks to idempotency keys.

## Instagram Stories

Phase 3.2 adds Story management on the **same** Content Manager, SQLite database, scheduler, and `content.publish` task type. There is no second queue or Highlights subsystem.

### Browser Story publishing (Phase 1)

Preferred path for this project: Playwright UI automation against your logged-in session (not Graph API).

```bash
npm run media:init
# place JPEG/PNG files in media/stories/pending/
npm run media:list
npm run media:inspect -- story-01.jpg

# Engine terminal:
# PUBLISHING_ADAPTER=playwright
# CONTENT_DRY_RUN=false
npm start

# Operator terminal:
npm run story:publish -- story-01.jpg --confirm
npm run story:status
```

Stories use the verified **mobile-web portrait** Playwright path (**390×844**, header `+` → Story). The desktop Story route is removed. Phases 0–4 stop at the verified editor and never click **Add to your story**. Details: [docs/story-browser-publishing.md](docs/story-browser-publishing.md).

### Creating a Story

```bash
npm run story:create -- \
  --title="Product Introduction" \
  --type=IMAGE \
  --media=./media/story.jpg

# Sequence multiple slides with the same group + order
npm run story:create -- --title="Slide 2" --type=IMAGE --media=./media/2.jpg --group=launch --order=1
```

`--type` for `story:create` is the Story media kind (`IMAGE` or `VIDEO`). The stored content type is always `STORY`, mapped to Graph `media_type=STORIES` at publish time.

### Story media requirements (Meta IG User Media reference)

| | Image Story | Video Story |
| --- | --- | --- |
| Format | JPEG | MP4 or MOV |
| Max size | 8 MB | 100 MB |
| Duration | — | 3–60 seconds |
| Aspect ratio | 9:16 recommended | 0.1:1 – 10:1 (9:16 recommended) |
| Max width | — | 1920 px |

Validation runs before approval/scheduling. Stickers, polls, and location stickers are **not** supported by the public Content Publishing API.

### Official Story publishing flow

1. Validate Professional account + token + permissions for the configured login flow
2. Resolve a public HTTPS media URL (`MEDIA_PUBLIC_BASE_URL`)
3. `POST /{IG_ID}/media` with `media_type=STORIES` and `image_url` or `video_url`
4. Poll container `status_code` until `FINISHED` when required (video)
5. `POST /{IG_ID}/media_publish` with `creation_id`
6. Persist the returned Instagram media ID and set `story_expires_at` (~24h)

Dry-run / mock paths never claim a real Instagram publication. Uncertain outcomes move the Story to `NEEDS_ATTENTION` — do **not** blind-retry.

### Story CLI

```bash
npm run media:init
npm run media:list
npm run media:inspect -- <filename>
npm run story:list
npm run story:show -- <story-id>
npm run story:approve -- <story-id>
npm run story:publish -- <filename> --confirm [--dry-run]
npm run story:status
npm run story:schedule -- <story-id> --at="2026-11-18T10:00:00+01:00"
npm run story:schedule -- --group=launch --at="2026-11-18T10:00:00+01:00" --stagger-ms=5000
npm run story:schedule -- <story-id> --now --confirm --dry-run
npm run story:cancel -- <story-id>
npm run story:history
npm run story:history -- <story-id>
```

### Story expiration

After a successful (non-dry-run) publish, `story_details.story_expires_at` is set to published time + 24 hours. While `npm start` is running, the Phase 2 scheduler sweeps due Stories each tick and marks them `EXPIRED`. Offline, use `npm run story:list -- --expire-due` (or `story:show`). Expiration is tracked separately from publishing success.

### API limitations

- Story publishing via the official Content Publishing API is supported (`media_type=STORIES`)
- Highlights creation / editing / adding Stories to Highlights are **not** implemented (no documented public API used here)
- Real publishing requires deploying HTTPS media hosting; this project provides a URL resolver (`MEDIA_PUBLIC_BASE_URL`), not a CDN

### Failure recovery

| Outcome | Content status | Operator action |
| --- | --- | --- |
| Confirmed adapter failure | `FAILED` | Fix media/caption/token, re-approve if needed, publish again |
| Timeout / unknown result | `NEEDS_ATTENTION` | Inspect `content:history`, verify Instagram manually, do **not** blind-retry |
| Dry-run / mock success | stays non-`PUBLISHED` for dry-run; mock may set `PUBLISHED` with `mock_pub_*` id | Treat mock IDs as simulated only |
| Duplicate idempotency key | prior attempt reused | Safe — no second publish request |

### Schedule tasks

Schedules are persisted in SQLite. Catch-up policy default: **`skip_missed`** — after downtime, enqueue at most one latest slot; never drain a large backlog; idempotency keys prevent duplicates.

```js
// From future modules / operator tooling (same process):
scheduler.schedule({
  taskType: 'engine.health-check',
  payload: { note: 'hourly' },
  intervalMs: 3_600_000,
  timezone: 'Europe/Berlin',
});
```

## Running

### Start the engine

```bash
npm start
```

Flow:

1. Open/migrate SQLite
2. Connect with CDP (default) or configured browser mode
3. Authenticate (auto/manual/storage-state)
4. Recover stale tasks
5. Start worker + scheduler + session monitor
6. Listen on a local Unix control socket (`./data/bot.sock`, mode `0600`)
7. On `Ctrl+C`: stop scheduling/claiming, cancel/wait for current task, flush persistence, close DB, disconnect Chrome without closing it

### Operator commands (separate terminal)

Human-readable terminal dashboards by default:

```bash
npm run status
npm run pause
npm run resume
npm run jobs
npm run jobs -- --limit 20
npm run jobs -- --verbose
npm run doctor
```

Machine-readable JSON (no ANSI / decoration). Use `--silent` so npm does not prepend script banners:

```bash
npm run status --silent -- --json
npm run jobs --silent -- --json
npm run doctor --silent -- --json
npm run pause --silent -- --json
npm run resume --silent -- --json
```

Content commands talk to SQLite directly (the bot does not need to be running for draft/approve/list). Scheduled and enqueued publishes are executed by the running engine (`npm start`).

```bash
npm run content:list
npm run content:list -- --status=DRAFT --json
npm run content:create -- --title="Post" --type=IMAGE --caption="..." --media=./a.jpg
npm run content:show -- <content-id>
npm run content:approve -- <content-id>
npm run content:schedule -- <content-id> --at="2026-11-11T10:00:00+01:00"
npm run content:cancel -- <content-id>
npm run content:history -- <content-id>

npm run story:list
npm run story:create -- --title="Story" --type=IMAGE --media=./story.jpg
npm run story:approve -- <story-id>
npm run story:schedule -- <story-id> --at="2026-11-18T10:00:00+01:00"
npm run story:history
```

If the bot is not running, control commands (`status` / `pause` / …) print an actionable error (start with `npm start`). Set `NO_COLOR=1` or pipe output to disable ANSI colors. Set `CLI_ASCII=1` for ASCII-only borders.

`node:sqlite` is experimental in Node.js 22. npm scripts pass `--disable-warning=ExperimentalWarning` (name-scoped, not `--no-warnings`) so the known SQLite notice does not clutter operator output. Deprecation and other warning classes still appear.

### Session provisioning

```bash
npm run login
```

Uses the same personal Chrome CDP path, then exports Instagram-only storage state.

### Optional server storage-state mode

```bash
BROWSER_MODE=storage-state npm start
```

## Authentication compatibility

Phase 2 reuses the existing auth stack without rewriting it:

- `BrowserManager` modes: `existing` | `launch` | `launch-x11` | `storage-state`
- `InstagramLogin.ensureAuthenticated()`
- `ensureStorageStateAuthenticated()` + `SessionPersistenceManager`
- Instagram-only storage-state filtering remains in place
- Cookies, tokens, and passwords are never logged

When authentication becomes invalid: auth-dependent tasks pause, the previous valid storage-state snapshot is not overwritten with an invalid one, and recovery instructions are logged / available via `status` / `doctor`.

## Intelligence Core (Phase 1)

Operational AI decision-making (not a chatbot). OpenRouter is the only production AI gateway.

```bash
npm run agent -- context import ./tests/fixtures/intelligence/sample-context.json --kind=brand --confirm
npm run agent -- history import ./tests/fixtures/intelligence/sample-decisions.csv --confirm
npm run agent -- execute "Analyze content performance and generate an operational plan"
npm run agent -- plans list
npm run agent -- plans approve <plan-id>
npm run agent -- ai status
npm run agent -- ai test
```

- Config docs: [docs/intelligence-openrouter.md](docs/intelligence-openrouter.md)
- Deterministic tests use `AI_PROVIDER=mock` / `--mock` and never claim mock output is real AI
- Phase 1 does **not** publish to Instagram; plans require owner approval

## Testing

```bash
npm test
```

Tests use mocked browser/platform adapters, a Mock AI provider, and in-memory SQLite. They do not use real Instagram credentials, OpenRouter credits, or perform real account actions.

## Troubleshooting

### Remote debugging not enabled

Open `chrome://inspect/#remote-debugging` and enable it.

### Task stuck in NEEDS_ATTENTION

Inspect with `npm run jobs`, fix the underlying auth/input issue, then enqueue a replacement task or manually resolve the row after confirming no duplicate side effect.

### Recover after restart

SQLite retains the queue. On startup the engine recovers stale `RUNNING` tasks using the side-effect-safe policy above, then continues.

### Control socket errors

Stale `data/bot.sock` files are removed on clean start. Token file `data/bot.control-token` authenticates local clients. Socket permissions must remain user-only.

## Security limitations

- Local Unix socket + token (not a network API)
- Single OS-user trust boundary
- Do not commit `.env`, `data/instagram-auth.json`, `data/bot.sqlite`, or control tokens
- Use only accounts you own or are authorized to manage

## Scope

Implemented: login/session infrastructure, durable single-account automation engine, content management / publishing foundation (mock + official Graph adapter), and Instagram Story management / publishing (`media_type=STORIES`).

Not implemented: multi-account support, comment moderation, messaging, insights dashboards, scraping-based publish, engagement manipulation, Instagram Highlights automation.
