import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ContentError, MEDIA_CONSTRAINTS } from './constants.js';

/**
 * Safe local media library. Never executes media files.
 * MIME detection uses magic bytes; extensions are never trusted alone.
 * Optional ffprobe (when available on PATH) enriches video preview metadata.
 */
export class MediaManager {
  /**
   * @param {{
   *   mediaDir: string,
   *   constraints?: typeof MEDIA_CONSTRAINTS,
   *   idFn?: () => string,
   *   ffprobePath?: string | null,
   *   enableFfprobe?: boolean,
   * }} options
   */
  constructor(options) {
    this.mediaDir = path.resolve(options.mediaDir);
    this.constraints = options.constraints ?? MEDIA_CONSTRAINTS;
    this._id = options.idFn ?? (() => randomUUID());
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.enableFfprobe = options.enableFfprobe !== false;
    /** @type {boolean | null} */
    this._ffprobeAvailable = null;
  }

  async ensureLibrary() {
    await fs.mkdir(this.mediaDir, { recursive: true });
  }

  /**
   * Import a local file into the media library and return metadata.
   *
   * @param {string} sourcePath
   * @param {{ originalName?: string }} [options]
   */
  async importFile(sourcePath, options = {}) {
    await this.ensureLibrary();

    const resolved = path.resolve(sourcePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new ContentError('Media source is not a file', {
        code: 'MEDIA_NOT_FILE',
        details: { path: resolved },
      });
    }

    const sniff = await this.sniffFile(resolved);
    this.assertAllowed(sniff.mimeType, sniff.mediaKind, stat.size);

    const checksum = await this.hashFile(resolved);
    const existing = await this.findByChecksum(checksum);
    if (existing) {
      return { ...existing, duplicateOf: existing.id, imported: false };
    }

    const originalName = options.originalName ?? path.basename(resolved);
    const safeName = this.buildSafeFileName(originalName, sniff.extension);
    const assetId = this._id();
    const destRelative = path.join(assetId.slice(0, 2), `${assetId}-${safeName}`);
    const destAbsolute = path.join(this.mediaDir, destRelative);
    await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
    await fs.copyFile(resolved, destAbsolute);

    const dimensions = await this.readPreviewMetadata(destAbsolute, sniff.mediaKind);

    return {
      id: assetId,
      filePath: destAbsolute,
      relativePath: destRelative,
      originalName,
      mimeType: sniff.mimeType,
      mediaKind: sniff.mediaKind,
      byteSize: stat.size,
      checksumSha256: checksum,
      width: dimensions.width,
      height: dimensions.height,
      durationMs: dimensions.durationMs,
      imported: true,
      duplicateOf: null,
    };
  }

  /**
   * @param {string} checksum
   */
  async findByChecksum(checksum) {
    await this.ensureLibrary();
    const entries = await this.listLibraryFiles();
    for (const filePath of entries) {
      const hash = await this.hashFile(filePath);
      if (hash === checksum) {
        const sniff = await this.sniffFile(filePath);
        const stat = await fs.stat(filePath);
        const dimensions = await this.readPreviewMetadata(filePath, sniff.mediaKind);
        const relativePath = path.relative(this.mediaDir, filePath);
        const base = path.basename(filePath);
        const idMatch = /^([0-9a-f-]{36})-/i.exec(base);
        return {
          id: idMatch?.[1] ?? base,
          filePath,
          relativePath,
          originalName: base,
          mimeType: sniff.mimeType,
          mediaKind: sniff.mediaKind,
          byteSize: stat.size,
          checksumSha256: checksum,
          width: dimensions.width,
          height: dimensions.height,
          durationMs: dimensions.durationMs,
          imported: false,
          duplicateOf: null,
        };
      }
    }
    return null;
  }

  /**
   * @returns {Promise<string[]>}
   */
  async listLibraryFiles() {
    /** @type {string[]} */
    const files = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    await walk(this.mediaDir);
    return files;
  }

  /**
   * @param {string} filePath
   * @returns {Promise<{ mimeType: string, mediaKind: string, extension: string }>}
   */
  async sniffFile(filePath) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(32);
      const { bytesRead } = await handle.read(buffer, 0, 32, 0);
      const slice = buffer.subarray(0, bytesRead);
      return this.detectMime(slice);
    } finally {
      await handle.close();
    }
  }

  /**
   * Magic-byte MIME detection. Extensions are ignored.
   * @param {Buffer} header
   */
  detectMime(header) {
    if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return { mimeType: 'image/jpeg', mediaKind: 'image', extension: 'jpg' };
    }
    if (
      header.length >= 8 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    ) {
      return { mimeType: 'image/png', mediaKind: 'image', extension: 'png' };
    }
    // ISO BMFF (MP4 / MOV): bytes 4..7 are 'ftyp'
    if (
      header.length >= 12 &&
      header[4] === 0x66 &&
      header[5] === 0x74 &&
      header[6] === 0x79 &&
      header[7] === 0x70
    ) {
      const brand = header.subarray(8, 12).toString('ascii');
      if (brand === 'qt  ') {
        return { mimeType: 'video/quicktime', mediaKind: 'video', extension: 'mov' };
      }
      return { mimeType: 'video/mp4', mediaKind: 'video', extension: 'mp4' };
    }

    throw new ContentError('Unrecognized or unsupported media format', {
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  /**
   * @param {string} mimeType
   * @param {string} mediaKind
   * @param {number} byteSize
   */
  assertAllowed(mimeType, mediaKind, byteSize) {
    if (mediaKind === 'image') {
      if (!this.constraints.allowedImageMimeTypes.includes(mimeType)) {
        throw new ContentError(`Image MIME type not allowed: ${mimeType}`, {
          code: 'UNSUPPORTED_MIME',
        });
      }
      if (byteSize > this.constraints.maxImageBytes) {
        throw new ContentError('Image exceeds maximum allowed size', {
          code: 'MEDIA_TOO_LARGE',
        });
      }
      return;
    }
    if (mediaKind === 'video') {
      if (!this.constraints.allowedVideoMimeTypes.includes(mimeType)) {
        throw new ContentError(`Video MIME type not allowed: ${mimeType}`, {
          code: 'UNSUPPORTED_MIME',
        });
      }
      if (byteSize > this.constraints.maxVideoBytes) {
        throw new ContentError('Video exceeds maximum allowed size', {
          code: 'MEDIA_TOO_LARGE',
        });
      }
      return;
    }
    throw new ContentError(`Unsupported media kind: ${mediaKind}`, {
      code: 'UNSUPPORTED_MEDIA_KIND',
    });
  }

  /**
   * @param {string} originalName
   * @param {string} extension
   */
  buildSafeFileName(originalName, extension) {
    const base = path
      .basename(originalName, path.extname(originalName))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
    const safeBase = base || 'media';
    const safeExt = String(extension).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    return `${safeBase}.${safeExt}`;
  }

  /**
   * @param {string} filePath
   */
  async hashFile(filePath) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  /**
   * Lightweight preview metadata without mutating originals.
   * JPEG SOF / PNG IHDR parsing for images; optional ffprobe for video.
   *
   * @param {string} filePath
   * @param {string} mediaKind
   */
  async readPreviewMetadata(filePath, mediaKind) {
    if (mediaKind === 'image') {
      const dims = await this.readImageDimensions(filePath);
      return { width: dims?.width ?? null, height: dims?.height ?? null, durationMs: null };
    }
    if (mediaKind === 'video' && this.enableFfprobe) {
      const probed = await this.probeVideoMetadata(filePath);
      if (probed) {
        return probed;
      }
    }
    return { width: null, height: null, durationMs: null };
  }

  /**
   * Best-effort ffprobe inspection. Never fails the import if ffprobe is missing.
   *
   * @param {string} filePath
   * @returns {Promise<{ width: number | null, height: number | null, durationMs: number | null } | null>}
   */
  async probeVideoMetadata(filePath) {
    const available = await this.isFfprobeAvailable();
    if (!available) {
      return null;
    }

    try {
      const stdout = await this._runFfprobe(filePath);
      const parsed = JSON.parse(stdout);
      const videoStream = Array.isArray(parsed.streams)
        ? parsed.streams.find((stream) => stream.codec_type === 'video')
        : null;
      const durationSec = Number.parseFloat(
        parsed.format?.duration ?? videoStream?.duration ?? '',
      );
      const width = videoStream?.width != null ? Number(videoStream.width) : null;
      const height = videoStream?.height != null ? Number(videoStream.height) : null;
      return {
        width: Number.isFinite(width) ? width : null,
        height: Number.isFinite(height) ? height : null,
        durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * @returns {Promise<boolean>}
   */
  async isFfprobeAvailable() {
    if (this._ffprobeAvailable != null) {
      return this._ffprobeAvailable;
    }
    this._ffprobeAvailable = await new Promise((resolve) => {
      const child = spawn(this.ffprobePath, ['-version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    return this._ffprobeAvailable;
  }

  /**
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  _runFfprobe(filePath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ];
      const child = spawn(this.ffprobePath, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`ffprobe exited with code ${code}`));
        }
      });
    });
  }

  /**
   * @param {string} filePath
   * @returns {Promise<{ width: number, height: number } | null>}
   */
  async readImageDimensions(filePath) {
    const buffer = await fs.readFile(filePath);
    if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          break;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0 / SOF2
        if (marker === 0xc0 || marker === 0xc2) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
    }
    return null;
  }
}
