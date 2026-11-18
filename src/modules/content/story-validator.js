import {
  ContentError,
  ContentType,
  STORY_MEDIA_CONSTRAINTS,
  STORY_MEDIA_TYPES,
  StoryMediaType,
} from './constants.js';

/**
 * @param {unknown} value
 * @returns {'IMAGE' | 'VIDEO'}
 */
export function normalizeStoryMediaType(value) {
  const type = String(value ?? StoryMediaType.IMAGE).trim().toUpperCase();
  if (!STORY_MEDIA_TYPES.includes(type)) {
    throw new ContentError(
      `Unsupported Story media type: ${value}. Expected IMAGE or VIDEO.`,
      { code: 'UNSUPPORTED_STORY_MEDIA_TYPE', details: { storyMediaType: value } },
    );
  }
  return /** @type {'IMAGE' | 'VIDEO'} */ (type);
}

/**
 * Infer Story media type from imported media when --type is omitted.
 *
 * @param {{ mediaKind?: string }} media
 * @returns {'IMAGE' | 'VIDEO'}
 */
export function inferStoryMediaType(media) {
  if (media?.mediaKind === 'video') {
    return StoryMediaType.VIDEO;
  }
  return StoryMediaType.IMAGE;
}

/**
 * Validate a single Story media asset against Meta Story specifications.
 *
 * @param {{
 *   mimeType: string,
 *   mediaKind: string,
 *   byteSize: number,
 *   width?: number | null,
 *   height?: number | null,
 *   durationMs?: number | null,
 * }} media
 * @param {{
 *   storyMediaType?: string,
 *   constraints?: typeof STORY_MEDIA_CONSTRAINTS,
 * }} [options]
 * @returns {{
 *   storyMediaType: 'IMAGE' | 'VIDEO',
 *   aspectRatio: number | null,
 *   preview: Record<string, unknown>,
 *   warnings: string[],
 * }}
 */
export function assertStoryMediaValid(media, options = {}) {
  const constraints = options.constraints ?? STORY_MEDIA_CONSTRAINTS;
  const warnings = [];

  if (!media) {
    throw new ContentError('Story requires exactly one media file', {
      code: 'MEDIA_REQUIRED',
    });
  }

  const expected =
    options.storyMediaType != null
      ? normalizeStoryMediaType(options.storyMediaType)
      : inferStoryMediaType(media);

  if (expected === StoryMediaType.IMAGE) {
    if (media.mediaKind !== 'image') {
      throw new ContentError('IMAGE Story requires an image file', {
        code: 'MEDIA_TYPE_MISMATCH',
        details: { expected: 'image', got: media.mediaKind },
      });
    }
    if (!constraints.allowedImageMimeTypes.includes(media.mimeType)) {
      throw new ContentError(
        `Story images must be JPEG (got ${media.mimeType}). Meta Story Image Specifications allow JPEG only.`,
        { code: 'UNSUPPORTED_MIME', details: { mimeType: media.mimeType } },
      );
    }
    if (media.byteSize > constraints.maxImageBytes) {
      throw new ContentError('Story image exceeds maximum allowed size (8 MB)', {
        code: 'MEDIA_TOO_LARGE',
        details: { byteSize: media.byteSize, max: constraints.maxImageBytes },
      });
    }
  } else {
    if (media.mediaKind !== 'video') {
      throw new ContentError('VIDEO Story requires a video file', {
        code: 'MEDIA_TYPE_MISMATCH',
        details: { expected: 'video', got: media.mediaKind },
      });
    }
    if (!constraints.allowedVideoMimeTypes.includes(media.mimeType)) {
      throw new ContentError(
        `Story videos must be MP4 or MOV (got ${media.mimeType})`,
        { code: 'UNSUPPORTED_MIME', details: { mimeType: media.mimeType } },
      );
    }
    if (media.byteSize > constraints.maxVideoBytes) {
      throw new ContentError('Story video exceeds maximum allowed size (100 MB)', {
        code: 'MEDIA_TOO_LARGE',
        details: { byteSize: media.byteSize, max: constraints.maxVideoBytes },
      });
    }
    if (media.durationMs != null) {
      if (media.durationMs < constraints.minVideoDurationMs) {
        throw new ContentError(
          `Story video must be at least ${constraints.minVideoDurationMs / 1000}s (Meta Story Video Specifications)`,
          {
            code: 'STORY_DURATION_TOO_SHORT',
            details: { durationMs: media.durationMs, min: constraints.minVideoDurationMs },
          },
        );
      }
      if (media.durationMs > constraints.maxVideoDurationMs) {
        throw new ContentError(
          `Story video must be at most ${constraints.maxVideoDurationMs / 1000}s (Meta Story Video Specifications)`,
          {
            code: 'STORY_DURATION_TOO_LONG',
            details: { durationMs: media.durationMs, max: constraints.maxVideoDurationMs },
          },
        );
      }
    } else {
      warnings.push(
        'Video duration could not be inspected (ffprobe unavailable). Meta requires 3–60 seconds for Story videos.',
      );
    }
  }

  let aspectRatio = null;
  if (media.width && media.height && media.width > 0 && media.height > 0) {
    aspectRatio = media.width / media.height;

    if (expected === StoryMediaType.VIDEO) {
      if (
        aspectRatio < constraints.minVideoAspectRatio ||
        aspectRatio > constraints.maxVideoAspectRatio
      ) {
        throw new ContentError(
          `Story video aspect ratio ${aspectRatio.toFixed(3)} is outside Meta bounds (${constraints.minVideoAspectRatio}:1 – ${constraints.maxVideoAspectRatio}:1)`,
          {
            code: 'STORY_ASPECT_RATIO',
            details: { aspectRatio, width: media.width, height: media.height },
          },
        );
      }
      if (media.width > constraints.maxVideoWidth) {
        throw new ContentError(
          `Story video width ${media.width}px exceeds Meta maximum of ${constraints.maxVideoWidth}px`,
          {
            code: 'STORY_RESOLUTION',
            details: { width: media.width, max: constraints.maxVideoWidth },
          },
        );
      }
    }

    const recommended = constraints.recommendedAspectRatio;
    const delta = Math.abs(aspectRatio - recommended);
    if (delta > constraints.recommendedAspectTolerance) {
      const message = `Story aspect ratio ${aspectRatio.toFixed(3)} differs from Meta's recommended 9:16 (${recommended.toFixed(3)})`;
      if (constraints.enforceRecommendedAspect) {
        throw new ContentError(message, {
          code: 'STORY_ASPECT_RATIO',
          details: { aspectRatio, recommended },
        });
      }
      warnings.push(`${message} — Instagram may crop or letterbox.`);
    }
  } else {
    warnings.push('Media dimensions unavailable; aspect-ratio checks skipped.');
  }

  return {
    storyMediaType: expected,
    aspectRatio,
    preview: {
      mimeType: media.mimeType,
      mediaKind: media.mediaKind,
      byteSize: media.byteSize,
      width: media.width ?? null,
      height: media.height ?? null,
      durationMs: media.durationMs ?? null,
      aspectRatio,
      recommendedAspectRatio: constraints.recommendedAspectRatio,
    },
    warnings,
  };
}

/**
 * Validate Story content readiness (exactly one media file + Story constraints).
 *
 * @param {{
 *   contentType?: string,
 *   media?: ReadonlyArray<object>,
 *   story?: { storyMediaType?: string } | null,
 * }} item
 * @param {{ constraints?: typeof STORY_MEDIA_CONSTRAINTS }} [options]
 */
export function assertStoryReady(item, options = {}) {
  if (String(item.contentType) !== ContentType.STORY) {
    throw new ContentError('Content is not a Story', {
      code: 'NOT_A_STORY',
      details: { contentType: item.contentType },
    });
  }

  const media = item.media ?? [];
  if (media.length !== 1) {
    throw new ContentError('STORY content requires exactly one media file', {
      code: 'MEDIA_TYPE_MISMATCH',
      details: { count: media.length },
    });
  }

  return assertStoryMediaValid(/** @type {any} */ (media[0]), {
    storyMediaType: item.story?.storyMediaType,
    constraints: options.constraints,
  });
}
