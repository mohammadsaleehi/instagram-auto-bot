import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaManager } from '../../src/modules/content/media-manager.js';
import { ContentError } from '../../src/modules/content/constants.js';

/** Minimal JFIF with SOF0 1x1 */
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9,
]);

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('MediaManager', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
    tempDirs.push(dir);
    return new MediaManager({ mediaDir: path.join(dir, 'library') });
  }

  it('imports jpeg by magic bytes and extracts dimensions', async () => {
    const manager = setup();
    const source = path.join(tempDirs[0], 'renamed.bin');
    fs.writeFileSync(source, TINY_JPEG);

    const asset = await manager.importFile(source, { originalName: 'shot.JPG' });
    expect(asset.mimeType).toBe('image/jpeg');
    expect(asset.mediaKind).toBe('image');
    expect(asset.imported).toBe(true);
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(fs.existsSync(asset.filePath)).toBe(true);
  });

  it('detects duplicates by checksum', async () => {
    const manager = setup();
    const source = path.join(tempDirs[0], 'a.png');
    fs.writeFileSync(source, TINY_PNG);
    const first = await manager.importFile(source);
    const second = await manager.importFile(source);
    expect(first.imported).toBe(true);
    expect(second.imported).toBe(false);
    expect(second.duplicateOf).toBe(first.id);
    expect(second.checksumSha256).toBe(first.checksumSha256);
  });

  it('rejects unrecognized formats even with image extensions', async () => {
    const manager = setup();
    const source = path.join(tempDirs[0], 'fake.jpg');
    fs.writeFileSync(source, Buffer.from('not-an-image'));
    await expect(manager.importFile(source)).rejects.toBeInstanceOf(ContentError);
  });
});
