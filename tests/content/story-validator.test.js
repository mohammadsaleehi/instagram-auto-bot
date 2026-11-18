import { describe, expect, it } from 'vitest';
import {
  assertStoryMediaValid,
  normalizeStoryMediaType,
} from '../../src/modules/content/story-validator.js';
import { assertMediaMatchesType } from '../../src/modules/content/content-validator.js';
import { ContentError, ContentStatus } from '../../src/modules/content/constants.js';
import { canTransition } from '../../src/modules/content/content-state-machine.js';

describe('Story media validation', () => {
  it('normalizes Story media types', () => {
    expect(normalizeStoryMediaType('image')).toBe('IMAGE');
    expect(normalizeStoryMediaType('VIDEO')).toBe('VIDEO');
    expect(() => normalizeStoryMediaType('REEL')).toThrow(ContentError);
  });

  it('accepts JPEG Story images', () => {
    const result = assertStoryMediaValid({
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      byteSize: 1024,
      width: 1080,
      height: 1920,
    });
    expect(result.storyMediaType).toBe('IMAGE');
    expect(result.preview.aspectRatio).toBeCloseTo(9 / 16, 5);
  });

  it('rejects PNG Story images (Meta Story Image Specs: JPEG only)', () => {
    expect(() =>
      assertStoryMediaValid({
        mimeType: 'image/png',
        mediaKind: 'image',
        byteSize: 100,
        width: 1080,
        height: 1920,
      }),
    ).toThrow(/JPEG/i);
  });

  it('rejects Story videos outside 3–60s when duration is known', () => {
    expect(() =>
      assertStoryMediaValid({
        mimeType: 'video/mp4',
        mediaKind: 'video',
        byteSize: 1000,
        width: 1080,
        height: 1920,
        durationMs: 1000,
      }),
    ).toThrow(/at least 3s/i);

    expect(() =>
      assertStoryMediaValid({
        mimeType: 'video/mp4',
        mediaKind: 'video',
        byteSize: 1000,
        width: 1080,
        height: 1920,
        durationMs: 61_000,
      }),
    ).toThrow(/at most 60s/i);
  });

  it('rejects Story videos outside Meta aspect ratio bounds', () => {
    expect(() =>
      assertStoryMediaValid({
        mimeType: 'video/mp4',
        mediaKind: 'video',
        byteSize: 1000,
        width: 1920,
        height: 10,
        durationMs: 5000,
      }),
    ).toThrow(/aspect ratio/i);
  });

  it('integrates Story rules into assertMediaMatchesType', () => {
    expect(() =>
      assertMediaMatchesType('STORY', [
        { mimeType: 'image/png', mediaKind: 'image', byteSize: 100 },
      ]),
    ).toThrow(ContentError);

    expect(() =>
      assertMediaMatchesType('STORY', [
        {
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 100,
          width: 1080,
          height: 1920,
        },
      ]),
    ).not.toThrow();
  });

  it('allows PUBLISHED → EXPIRED for Story lifecycle', () => {
    expect(canTransition(ContentStatus.PUBLISHED, ContentStatus.EXPIRED)).toBe(true);
    expect(canTransition(ContentStatus.EXPIRED, ContentStatus.DRAFT)).toBe(false);
  });
});
