import { promises as fs } from 'node:fs';
import path from 'node:path';

const TOKEN_PATTERNS = [
  /(sessionid|csrftoken|ds_user_id|ig_did|mid|rur|datr)=([^&\s]+)/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /("?(?:password|passwd|token|secret|authorization|cookie)"?\s*[:=]\s*")([^"]+)(")/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/**
 * @param {string} value
 * @returns {string}
 */
export function redactText(value) {
  if (typeof value !== 'string') return '';
  let out = value;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match, prefix, secret, suffix) => {
      if (suffix !== undefined) return `${prefix}[REDACTED]${suffix}`;
      if (prefix !== undefined) return `${prefix}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function redactUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactText(value);
  }
}

/**
 * Per-operation Story diagnostics.
 *
 * - One directory per operation.
 * - Screenshots only through CDP `Page.captureScreenshot`.
 * - URLs are stripped of query/fragment tokens.
 * - DOM text is truncated and redacted.
 * - No cookies/storage-state content is ever written.
 */
export class StoryDiagnostics {
  /**
   * @param {{
   *   rootDir?: string|null,
   *   operationId: string,
   *   logger?: { warn?: Function } | null,
   *   retention?: number,
   * }} options
   */
  constructor(options) {
    this.rootDir = options.rootDir ?? null;
    this.operationId = options.operationId;
    this.logger = options.logger ?? null;
    this.retention = options.retention ?? 20;
    this.dir = this.rootDir ? path.join(this.rootDir, this.operationId) : null;
    this.artifacts = [];
    this._counter = 0;
    this._startedAt = new Date().toISOString();
  }

  /** @returns {Promise<void>} */
  async ensureDir() {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
  }

  /**
   * @param {{
   *   page: import('playwright').Page,
   *   cdp: import('playwright').CDPSession|null,
   *   stage: string,
   *   extra?: Record<string, unknown>,
   *   environment?: Record<string, unknown>,
   * }} input
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async capture(input) {
    if (!this.dir) return null;
    await this.ensureDir();
    this._counter += 1;
    const prefix = `${String(this._counter).padStart(2, '0')}-${sanitize(input.stage)}`;
    const screenshotPath = path.join(this.dir, `${prefix}.png`);
    const jsonPath = path.join(this.dir, `${prefix}.json`);

    let screenshotOk = false;
    if (input.cdp) {
      try {
        const { data } = await input.cdp.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(screenshotPath, Buffer.from(data, 'base64'));
        screenshotOk = true;
      } catch (error) {
        this.logger?.warn?.('CDP screenshot failed', {
          stage: input.stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let dom = {};
    try {
      dom = await input.page.evaluate(() => {
        const text = (document.body?.innerText || '').slice(0, 2500);
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        };
        const shareCandidates = Array.from(
          document.querySelectorAll('button, [role="button"], div[role="button"]'),
        )
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            aria: el.getAttribute('aria-label'),
            text: (el.innerText || '').trim().slice(0, 60),
            disabled: el.getAttribute('aria-disabled') || el.disabled || null,
            box: rect(el),
          }))
          .filter((row) => /add to your story|share/i.test(`${row.aria || ''} ${row.text}`))
          .slice(0, 20);
        const canvases = Array.from(document.querySelectorAll('canvas'))
          .map((canvas) => ({
            width: canvas.width,
            height: canvas.height,
            box: rect(canvas),
          }))
          .slice(0, 10);
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(
          (el) => ({
            accept: el.getAttribute('accept'),
            display: getComputedStyle(el).display,
            inDialog: Boolean(el.closest('[role="dialog"]')),
          }),
        );
        return {
          url: location.href,
          title: document.title.slice(0, 120),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          screen: {
            width: window.screen?.width ?? null,
            height: window.screen?.height ?? null,
            orientation: window.screen?.orientation?.type ?? null,
          },
          bodySnippet: text.slice(0, 500),
          hasRotateText: /rotate\s+your\s+device/i.test(text),
          shareCandidates,
          canvases,
          fileInputs,
          dialogCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
        };
      });
    } catch (error) {
      dom = { evaluateError: error instanceof Error ? error.message : String(error) };
    }

    const record = {
      operationId: this.operationId,
      stage: input.stage,
      capturedAt: new Date().toISOString(),
      screenshot: screenshotOk ? path.basename(screenshotPath) : null,
      environment: sanitizeObject(input.environment ?? {}),
      ...sanitizeObject(dom),
      ...sanitizeObject(input.extra ?? {}),
    };
    await fs.writeFile(jsonPath, JSON.stringify(record, null, 2));
    this.artifacts.push({ stage: input.stage, json: path.basename(jsonPath), screenshot: record.screenshot });
    return { dir: this.dir, screenshotPath: screenshotOk ? screenshotPath : null, jsonPath };
  }

  /**
   * Write an index and prune old operation directories.
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async finalize(extra = {}) {
    if (!this.dir) return null;
    await this.ensureDir();
    const index = {
      operationId: this.operationId,
      startedAt: this._startedAt,
      finishedAt: new Date().toISOString(),
      artifacts: this.artifacts,
      ...sanitizeObject(extra),
    };
    const indexPath = path.join(this.dir, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    await this._prune();
    return { dir: this.dir, indexPath, index };
  }

  /** @returns {Promise<void>} */
  async _prune() {
    if (!this.rootDir) return;
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
      const dirs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(this.rootDir, entry.name);
        const stat = await fs.stat(full);
        dirs.push({ full, mtimeMs: stat.mtimeMs });
      }
      dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const stale of dirs.slice(this.retention)) {
        await fs.rm(stale.full, { recursive: true, force: true });
      }
    } catch (error) {
      this.logger?.warn?.('Story diagnostics prune failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitize(value) {
  return String(value ?? 'stage')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'stage';
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function sanitizeObject(value) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (key === 'url' && typeof raw === 'string') {
      out[key] = redactUrl(raw);
    } else if (typeof raw === 'string') {
      out[key] = redactText(raw).slice(0, 2000);
    } else if (Array.isArray(raw)) {
      out[key] = raw.slice(0, 50).map((item) =>
        item && typeof item === 'object' ? sanitizeObject(item) : typeof item === 'string' ? redactText(item) : item,
      );
    } else if (raw && typeof raw === 'object') {
      out[key] = sanitizeObject(/** @type {Record<string, unknown>} */ (raw));
    } else {
      out[key] = raw;
    }
  }
  return out;
}
