import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoryMediaInbox } from '../../src/modules/content/story-media-inbox.js';
import { ContentError } from '../../src/modules/content/constants.js';

const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9,
]);

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('StoryMediaInbox', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-inbox-'));
    tempDirs.push(dir);
    const inbox = new StoryMediaInbox({
      storyMediaDir: path.join(dir, 'stories'),
      nowFn: () => new Date('2026-11-18T12:00:00.000Z'),
    });
    return { dir, inbox };
  }

  it('initialize creates pending/published/failed only', async () => {
    const { inbox } = setup();
    expect(await inbox.exists()).toBe(false);
    const result = await inbox.initialize();
    expect(await inbox.exists()).toBe(true);
    expect(fs.existsSync(result.pendingDir)).toBe(true);
    expect(fs.existsSync(result.publishedDir)).toBe(true);
    expect(fs.existsSync(result.failedDir)).toBe(true);
  });

  it('lists only pending files and never picks randomly', async () => {
    const { inbox } = setup();
    await inbox.initialize();
    fs.writeFileSync(path.join(inbox.pendingDir, 'b.jpg'), TINY_JPEG);
    fs.writeFileSync(path.join(inbox.pendingDir, 'a.jpg'), TINY_JPEG);
    fs.writeFileSync(path.join(inbox.publishedDir, 'old.jpg'), TINY_JPEG);
    fs.mkdirSync(path.join(inbox.pendingDir, 'subdir'));
    fs.writeFileSync(path.join(inbox.pendingDir, 'subdir', 'nested.jpg'), TINY_JPEG);

    const listed = await inbox.listPending();
    expect(listed.map((f) => f.fileName)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('resolves exact filename from pending and rejects missing', async () => {
    const { inbox } = setup();
    await inbox.initialize();
    fs.writeFileSync(path.join(inbox.pendingDir, 'story-01.jpg'), TINY_JPEG);

    const resolved = await inbox.resolveExact('story-01.jpg');
    expect(resolved).toBe(path.join(inbox.pendingDir, 'story-01.jpg'));

    await expect(inbox.resolveExact('missing.jpg')).rejects.toBeInstanceOf(ContentError);
    await expect(inbox.resolveExact('')).rejects.toBeInstanceOf(ContentError);
  });

  it('validates jpeg/png and rejects corrupted files', async () => {
    const { inbox } = setup();
    await inbox.initialize();
    const jpegPath = path.join(inbox.pendingDir, 'ok.jpg');
    const pngPath = path.join(inbox.pendingDir, 'ok.png');
    const badPath = path.join(inbox.pendingDir, 'bad.jpg');
    fs.writeFileSync(jpegPath, TINY_JPEG);
    fs.writeFileSync(pngPath, TINY_PNG);
    fs.writeFileSync(badPath, Buffer.from('not-an-image'));

    await expect(inbox.assertPublishable(jpegPath)).resolves.toMatchObject({
      valid: true,
      mimeType: 'image/jpeg',
    });
    await expect(inbox.assertPublishable(pngPath)).resolves.toMatchObject({
      valid: true,
      mimeType: 'image/png',
    });
    await expect(inbox.assertPublishable(badPath)).rejects.toBeInstanceOf(ContentError);
  });

  it('archives without overwriting and preserves content via relocate', async () => {
    const { inbox } = setup();
    await inbox.initialize();
    const source = path.join(inbox.pendingDir, 'story-01.jpg');
    fs.writeFileSync(source, TINY_JPEG);

    const archived = await inbox.archivePublished(source);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(archived.to)).toBe(true);
    expect(path.dirname(archived.to)).toBe(inbox.publishedDir);
  });
});
