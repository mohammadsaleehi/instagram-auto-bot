import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ContentError, BROWSER_STORY_MEDIA_CONSTRAINTS } from './constants.js';
import { MediaManager } from './media-manager.js';
import { assertStoryMediaValid } from './story-validator.js';

export const STORY_INBOX_BUCKETS = Object.freeze({
  PENDING: 'pending',
  PUBLISHED: 'published',
  FAILED: 'failed',
});

export const DEFAULT_STORY_MEDIA_DIR = './media/stories';

/**
 * Operator drop-zone for Story images.
 *
 * Layout (created only by {@link StoryMediaInbox.initialize}):
 *   {storyMediaDir}/pending/
 *   {storyMediaDir}/published/
 *   {storyMediaDir}/failed/
 *
 * Never picks a random file. Never overwrites. Never deletes the original
 * without relocating it into published/ or failed/.
 */
export class StoryMediaInbox {
  /**
   * @param {{
   *   storyMediaDir: string,
   *   mediaManager?: MediaManager,
   *   constraints?: typeof BROWSER_STORY_MEDIA_CONSTRAINTS,
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    this.rootDir = path.resolve(options.storyMediaDir);
    this.pendingDir = path.join(this.rootDir, STORY_INBOX_BUCKETS.PENDING);
    this.publishedDir = path.join(this.rootDir, STORY_INBOX_BUCKETS.PUBLISHED);
    this.failedDir = path.join(this.rootDir, STORY_INBOX_BUCKETS.FAILED);
    this.constraints = options.constraints ?? BROWSER_STORY_MEDIA_CONSTRAINTS;
    this.mediaManager =
      options.mediaManager ??
      new MediaManager({
        // Used only for sniff/hash/dimension helpers — never as a write target here.
        mediaDir: this.pendingDir,
        constraints: this.constraints,
      });
    this._now = options.nowFn ?? (() => new Date());
  }

  /** Create pending / published / failed directories (idempotent). */
  async initialize() {
    for (const dir of [this.pendingDir, this.publishedDir, this.failedDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
    return {
      rootDir: this.rootDir,
      pendingDir: this.pendingDir,
      publishedDir: this.publishedDir,
      failedDir: this.failedDir,
      created: true,
    };
  }

  /**
   * @returns {Promise<boolean>}
   */
  async exists() {
    try {
      const stat = await fs.stat(this.pendingDir);
      return stat.isDirectory();
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * List supported Story media files in pending/ only.
   * Does not recurse into unrelated folders.
   *
   * @returns {Promise<Array<{
   *   fileName: string,
   *   filePath: string,
   *   byteSize: number,
   *   mimeType: string,
   *   mediaKind: string,
   *   width: number | null,
   *   height: number | null,
   *   valid: boolean,
   *   error?: string,
   * }>>}
   */
  async listPending() {
    if (!(await this.exists())) {
      return [];
    }

    const entries = await fs.readdir(this.pendingDir, { withFileTypes: true });
    /** @type {Array<any>} */
    const results = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      const filePath = path.join(this.pendingDir, entry.name);
      try {
        const inspected = await this.inspectFile(filePath);
        results.push({
          fileName: entry.name,
          filePath: inspected.filePath,
          byteSize: inspected.byteSize,
          mimeType: inspected.mimeType,
          mediaKind: inspected.mediaKind,
          width: inspected.width,
          height: inspected.height,
          valid: inspected.valid,
          error: inspected.error,
        });
      } catch (error) {
        results.push({
          fileName: entry.name,
          filePath,
          byteSize: 0,
          mimeType: 'unknown',
          mediaKind: 'unknown',
          width: null,
          height: null,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    results.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return results;
  }

  /**
   * Resolve an exact pending filename or absolute/relative path.
   * Never selects a random file.
   *
   * @param {string} selector
   * @returns {Promise<string>} absolute path
   */
  async resolveExact(selector) {
    const raw = String(selector ?? '').trim();
    if (!raw) {
      throw new ContentError('Media selector is required (exact filename or path)', {
        code: 'MEDIA_SELECTOR_REQUIRED',
      });
    }

    const asPath = path.resolve(raw);
    try {
      const stat = await fs.stat(asPath);
      if (stat.isFile()) {
        return asPath;
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    const pendingCandidate = path.join(this.pendingDir, path.basename(raw));
    try {
      const stat = await fs.stat(pendingCandidate);
      if (stat.isFile()) {
        // Require exact basename match when selecting from pending (no glob).
        if (path.basename(raw) !== path.basename(pendingCandidate)) {
          throw new ContentError('Ambiguous media selector', {
            code: 'MEDIA_SELECTOR_AMBIGUOUS',
            details: { selector: raw },
          });
        }
        return pendingCandidate;
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    throw new ContentError(
      `Media file not found: ${raw}. Place the file in ${this.pendingDir} or pass an absolute path.`,
      {
        code: 'MEDIA_NOT_FOUND',
        details: { selector: raw, pendingDir: this.pendingDir },
      },
    );
  }

  /**
   * Inspect and validate a Story image for browser publishing.
   *
   * @param {string} filePath
   */
  async inspectFile(filePath) {
    const resolved = path.resolve(filePath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        throw new ContentError(`Media file not found: ${resolved}`, {
          code: 'MEDIA_NOT_FOUND',
          details: { path: resolved },
        });
      }
      throw error;
    }

    if (!stat.isFile()) {
      throw new ContentError('Media path is not a file', {
        code: 'MEDIA_NOT_FILE',
        details: { path: resolved },
      });
    }

    if (stat.size === 0) {
      return {
        filePath: resolved,
        fileName: path.basename(resolved),
        byteSize: 0,
        mimeType: 'unknown',
        mediaKind: 'unknown',
        width: null,
        height: null,
        durationMs: null,
        checksumSha256: null,
        valid: false,
        error: 'File is empty',
        warnings: [],
      };
    }

    try {
      const sniff = await this.mediaManager.sniffFile(resolved);
      this.mediaManager.assertAllowed(sniff.mimeType, sniff.mediaKind, stat.size);
      const dimensions = await this.mediaManager.readPreviewMetadata(
        resolved,
        sniff.mediaKind,
      );
      const checksumSha256 = await this.mediaManager.hashFile(resolved);
      const media = {
        mimeType: sniff.mimeType,
        mediaKind: sniff.mediaKind,
        byteSize: stat.size,
        width: dimensions.width,
        height: dimensions.height,
        durationMs: dimensions.durationMs,
      };
      const storyCheck = assertStoryMediaValid(media, {
        constraints: this.constraints,
      });
      return {
        filePath: resolved,
        fileName: path.basename(resolved),
        byteSize: stat.size,
        mimeType: sniff.mimeType,
        mediaKind: sniff.mediaKind,
        width: dimensions.width,
        height: dimensions.height,
        durationMs: dimensions.durationMs,
        checksumSha256,
        valid: true,
        error: undefined,
        warnings: storyCheck.warnings,
        storyMediaType: storyCheck.storyMediaType,
        preview: storyCheck.preview,
      };
    } catch (error) {
      return {
        filePath: resolved,
        fileName: path.basename(resolved),
        byteSize: stat.size,
        mimeType: 'unknown',
        mediaKind: 'unknown',
        width: null,
        height: null,
        durationMs: null,
        checksumSha256: null,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
      };
    }
  }

  /**
   * Validate that a resolved file is publishable. Throws on invalid.
   *
   * @param {string} filePath
   */
  async assertPublishable(filePath) {
    const inspected = await this.inspectFile(filePath);
    if (!inspected.valid) {
      throw new ContentError(inspected.error ?? 'Media failed validation', {
        code: 'MEDIA_INVALID',
        details: { path: inspected.filePath },
      });
    }
    if (inspected.mediaKind !== 'image') {
      throw new ContentError(
        'Phase 1 browser Story publishing supports image files only',
        {
          code: 'UNSUPPORTED_MEDIA_KIND',
          details: { mediaKind: inspected.mediaKind },
        },
      );
    }
    return inspected;
  }

  /**
   * Relocate a file into published/ without overwriting.
   * Prefer rename within the same filesystem; fall back to copy+unlink.
   *
   * @param {string} sourcePath
   * @param {{ reason?: string }} [options]
   */
  async archivePublished(sourcePath, options = {}) {
    return this._archive(sourcePath, this.publishedDir, options.reason ?? 'published');
  }

  /**
   * Relocate a file into failed/ without overwriting.
   *
   * @param {string} sourcePath
   * @param {{ reason?: string }} [options]
   */
  async archiveFailed(sourcePath, options = {}) {
    return this._archive(sourcePath, this.failedDir, options.reason ?? 'failed');
  }

  /**
   * @param {string} sourcePath
   * @param {string} destDir
   * @param {string} reason
   */
  async _archive(sourcePath, destDir, reason) {
    const resolved = path.resolve(sourcePath);
    await fs.mkdir(destDir, { recursive: true });

    const base = path.basename(resolved);
    const stamp = this._now()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .replace('Z', '');
    const destName = `${stamp}__${base}`;
    const destPath = path.join(destDir, destName);

    try {
      await fs.access(destPath);
      throw new ContentError('Archive destination already exists (refusing overwrite)', {
        code: 'ARCHIVE_EXISTS',
        details: { destPath },
      });
    } catch (error) {
      if (error instanceof ContentError) {
        throw error;
      }
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await fs.rename(resolved, destPath);
    } catch {
      await fs.copyFile(resolved, destPath);
      await fs.unlink(resolved);
    }

    return {
      from: resolved,
      to: destPath,
      reason,
    };
  }
}
