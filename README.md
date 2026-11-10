# Instagram Auto Bot (Login MVP)

Minimal Instagram automation project built with **JavaScript (ES Modules)**, **Node.js**, and **Playwright**.

By default the bot attaches to your already-running Google Chrome instance over CDP and opens Instagram in a **new tab** in that same window.

It can:

- Detect an existing Instagram session in your personal Chrome
- Perform **automatic login** when credentials are configured
- Fall back to manual login
- Wait for manual 2FA / checkpoint / CAPTCHA completion
- Provision an authenticated Playwright storage state with `npm run login` (same personal Chrome via CDP)
- Optionally reuse that state on a server with `BROWSER_MODE=storage-state`

No follow, like, comment, DM, scraping, or publishing features are included.

## Installation

```bash
npm install
cp .env.example .env
```

Requires Node.js 20 LTS or newer and Google Chrome.

Enable remote debugging before running:

1. Open Chrome
2. Go to `chrome://inspect/#remote-debugging`
3. Enable **Allow remote debugging for this browser instance**

## Configuration

```env
BROWSER_MODE=existing
BROWSER_CDP_ENDPOINT=chrome
BROWSER_CHANNEL=chrome

AUTO_LOGIN=true
INSTAGRAM_USERNAME=
INSTAGRAM_PASSWORD=

HEADLESS=false
AUTH_STORAGE_STATE_PATH=./data/instagram-auth.json
AUTH_STATE_SAVE_INTERVAL_MS=300000
```

| Variable | Default | Description |
| --- | --- | --- |
| `AUTO_LOGIN` | `true` | When true and both credentials are set, fill/submit the login form automatically |
| `INSTAGRAM_USERNAME` | _(empty)_ | Instagram username/email/phone for automatic login |
| `INSTAGRAM_PASSWORD` | _(empty)_ | Instagram password for automatic login |
| `BROWSER_MODE` | `existing` | `existing` (CDP, default), `launch`, `launch-x11`, or optional `storage-state` |
| `BROWSER_CDP_ENDPOINT` | `chrome` | CDP channel/URL for existing mode |
| `BROWSER_EXECUTABLE_PATH` | mode-dependent | Absolute Chrome/Chromium path. Defaults to `/usr/bin/google-chrome-stable` for `launch-x11` / `storage-state` |
| `BROWSER_PLATFORM` | `x11` on Linux | Forced to `x11` for `launch-x11` (`--ozone-platform=x11`) |
| `USER_DATA_DIR` | mode-dependent | `./sessions/instagram` by default; `./sessions/instagram-x11` for `launch-x11` |
| `AUTH_STORAGE_STATE_PATH` | `./data/instagram-auth.json` | Used by `npm run login` and optional `storage-state` mode |
| `AUTH_STATE_SAVE_INTERVAL_MS` | `300000` | Periodic storage-state re-export interval (storage-state mode only) |
| `LOGIN_TIMEOUT` | `300000` | Max wait for login / verification (ms) |
| `NAVIGATION_TIMEOUT` | `60000` | Navigation timeout (ms) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

### Browser modes

**`existing` (default)** — attach to your already-open Chrome over CDP. Uses your normal Chrome profile/session. Does not use `./sessions/instagram`.

**`launch`** — isolated persistent Playwright profile (`./sessions/instagram` by default).

**`launch-x11`** — launch a separate Google Chrome window with X11:

```env
BROWSER_MODE=launch-x11
HEADLESS=false
```

Presets applied automatically:

- Executable: `/usr/bin/google-chrome-stable`
- Platform/arg: `x11` / `--ozone-platform=x11`
- Profile: `./sessions/instagram-x11` (isolated from `./sessions/instagram` and from your normal Chrome profile)

**`storage-state` (optional server mode)** — headless browser loaded from a transferred Playwright storage state. Not the default.

### Automatic login rules

- Both credentials empty → manual login in the browser
- Only one credential set → configuration error (values are never printed)
- `AUTO_LOGIN=true` + both credentials → automatic fill/submit once
- Already authenticated → skip login entirely
- 2FA / checkpoint / CAPTCHA → keep the browser open and wait for manual completion
- `storage-state` mode never creates a fresh unauthenticated session; it requires a valid exported state

Credentials are never logged, never hardcoded, and `.env` is gitignored.

## Running the Bot

### Default personal Chrome (CDP)

```bash
npm start
```

Flow:

1. Connect with `chromium.connectOverCDP('chrome')`
2. Reuse the existing Chrome context
3. Open Instagram in a new tab
4. Detect authentication state
5. Auto-login or wait for manual login / verification
6. On `Ctrl+C`, disconnect without closing Chrome

### Standalone session provisioning

Uses the **same already-open personal Chrome window** over CDP. Does not launch another Chrome process.

```bash
npm run login
```

1. Connects with `chromium.connectOverCDP('chrome')`
2. Reuses your existing Chrome context
3. Opens Instagram in a new tab
4. Reuses the shared `InstagramLogin` helper: skip login if already authenticated; otherwise auto-fill/submit once when `AUTO_LOGIN=true` and credentials are set
5. If CAPTCHA / 2FA / checkpoint appears, pauses for manual completion (no automatic bypass)
6. After `AUTHENTICATED`, **automatically** exports **Instagram-only** storage state to `data/instagram-auth.json` (mode `0600`) — Enter is not required to save
7. Optionally waits for Enter only to finish/disconnect
8. Disconnects Playwright without closing Chrome or your other tabs

Unrelated personal cookies (Google, GitHub, ChatGPT, etc.) are filtered out before saving.

Transfer securely:

```bash
scp data/instagram-auth.json USER@SERVER:/PATH/TO/Instagram-Auto-Bot/data/instagram-auth.json
chmod 700 data
chmod 600 data/instagram-auth.json
```

Never transfer auth state via Telegram, GitHub, or public file-sharing services.

### Optional server storage-state mode

```bash
BROWSER_MODE=storage-state npm start
```

Loads `AUTH_STORAGE_STATE_PATH`, verifies authentication, and periodically persists the state. Does not change the default `npm start` personal Chrome workflow.

### X11 launch mode

```bash
BROWSER_MODE=launch-x11 npm start
```

Or set `BROWSER_MODE=launch-x11` in `.env`, then run `npm start`.

## First Login (personal Chrome)

1. Enable Chrome remote debugging.
2. Put credentials in `.env` if you want automatic login, or leave them empty for manual login.
3. Run `npm start`.
4. If Instagram asks for 2FA/checkpoint/CAPTCHA, complete it in the open tab.
5. Wait for `Authentication successful` / `Ready`.
6. Press `Ctrl+C` to stop. Chrome stays open.

## Login selectors

Verified against the live Instagram login DOM:

- Username: `input[name="email"]` (fallback: `input[name="username"]`)
- Password: `input[name="pass"]` (fallback: `input[name="password"]`)
- Submit: accessible `Log in` button / `div[aria-label="Log In"]`
- Form: `form#login_form`

## Captcha bypass module

Optional drop-in helper for token-based captcha solving during automation:

```js
import { CaptchaBypass } from './src/captcha/index.js';

const bypass = new CaptchaBypass({
  solver: '2captcha', // or 'capsolver'
  apiKey: process.env.CAPTCHA_API_KEY,
  headless: false,
  proxy: process.env.PROXY || null,
  timeoutMs: 120000,
  maxRetries: 2,
  humanize: true,
});

const { page } = await bypass.launch();
await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

const result = await bypass.solve(page, {
  type: 'auto', // auto | recaptcha_v2 | recaptcha_v3 | hcaptcha | turnstile
  action: 'login',
  minScore: 0.7,
  submitSelector: null,
});
```

Layers:

1. **Avoidance** — sane browser defaults + light humanization (does **not** create a valid token)
2. **Solve** — paid solver API (`2captcha` / `capsolver`) returns a token
3. **Inject** — write response fields and fire callbacks; **never click the checkbox** when injecting

Important v3 note: many sites ignore the hidden textarea and only accept tokens from their own `grecaptcha.execute` flow. Detection/injection covers common cases, but some v3 deployments still need site-specific callback wiring.

Google demo acceptance script (requires a real API key; will not fake success):

```bash
CAPTCHA_API_KEY=... npm run captcha:demo
```

## Testing

```bash
npm test
```

## Troubleshooting

### Remote debugging not enabled

Open `chrome://inspect/#remote-debugging` and enable it. The bot will not launch a separate browser as a fallback.

### Login form / button not found

Instagram may have changed markup. Update `src/auth/selectors.js`.

### Invalid credentials

The bot submits once, then stops automatic retries. Fix credentials in `.env` or complete login manually.

### Verification required

Complete 2FA/checkpoint/CAPTCHA in Chrome. The bot keeps waiting until `LOGIN_TIMEOUT`.

## Security

- Do not commit `.env` or credentials
- Do not share passwords in chat
- Use only accounts you own or are authorized to access

## Scope

This MVP intentionally excludes follow/unfollow, likes, comments, DMs, publishing, scraping, proxies, CAPTCHA solving, and multi-account management.
