import { describe, expect, it } from 'vitest';
import {
  assertCaptionValid,
  assertMediaMatchesType,
  normalizeHashtags,
  normalizeContentType,
} from '../../src/modules/content/content-validator.js';
import { canTransition } from '../../src/modules/content/content-state-machine.js';
import { ContentError, ContentStatus } from '../../src/modules/content/constants.js';
import { CaptionManager } from '../../src/modules/content/caption-manager.js';

describe('content validators', () => {
  it('normalizes hashtags and rejects invalid ones', () => {
    expect(normalizeHashtags(['launch', '#Bot', 'launch'])).toEqual(['#launch', '#Bot']);
    expect(() => normalizeHashtags(['bad-tag!'])).toThrow(ContentError);
  });

  it('validates caption length', () => {
    expect(() => assertCaptionValid('a'.repeat(2201))).toThrow(ContentError);
    expect(() => assertCaptionValid('ok')).not.toThrow();
  });

  it('validates media against content type', () => {
    expect(() =>
      assertMediaMatchesType('IMAGE', [
        { mimeType: 'image/jpeg', mediaKind: 'image', byteSize: 100 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertMediaMatchesType('CAROUSEL', [
        { mimeType: 'image/jpeg', mediaKind: 'image', byteSize: 100 },
      ]),
    ).toThrow(ContentError);
    expect(normalizeContentType('reel')).toBe('REEL');
  });

  it('keeps caption suggestions separate from approved content', () => {
    const captions = new CaptionManager();
    const composed = captions.compose('Hello', ['news']);
    expect(composed.preview).toContain('#news');
    expect(captions.suggest('Hello').suggestedHashtags).toEqual([]);
  });

  it('enforces approval lifecycle transitions', () => {
    expect(canTransition(ContentStatus.DRAFT, ContentStatus.READY_FOR_REVIEW)).toBe(true);
    expect(canTransition(ContentStatus.APPROVED, ContentStatus.SCHEDULED)).toBe(true);
    expect(canTransition(ContentStatus.DRAFT, ContentStatus.PUBLISHED)).toBe(false);
    expect(canTransition(ContentStatus.PUBLISHING, ContentStatus.NEEDS_ATTENTION)).toBe(true);
  });
});
