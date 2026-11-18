import {
  CONTENT_TYPES,
  ContentError,
  ContentType,
  MEDIA_CONSTRAINTS,
  STORY_MEDIA_CONSTRAINTS,
} from './constants.js';
import { assertStoryMediaValid } from './story-validator.js';

const CAPTION_MAX_LENGTH = 2200;
const HASHTAG_MAX_COUNT = 30;
const TITLE_MAX_LENGTH = 200;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCaption(value) {
  if (value == null) {
    return '';
  }
  return String(value).replace(/\r\n/g, '\n').trimEnd();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeHashtags(value) {
  /** @type {string[]} */
  let raw = [];
  if (Array.isArray(value)) {
    raw = value.map((item) => String(item));
  } else if (typeof value === 'string') {
    raw = value.split(/[\s,]+/);
  } else if (value == null) {
    raw = [];
  } else {
    throw new ContentError('Hashtags must be a string or array', {
      code: 'INVALID_HASHTAGS',
    });
  }

  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  for (const item of raw) {
    let tag = item.trim();
    if (!tag) {
      continue;
    }
    if (!tag.startsWith('#')) {
      tag = `#${tag}`;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    if (!/^#[A-Za-z0-9_]+$/.test(tag)) {
      throw new ContentError(`Invalid hashtag: ${tag}`, {
        code: 'INVALID_HASHTAG',
        details: { tag },
      });
    }
    seen.add(key);
    result.push(tag);
  }

  if (result.length > HASHTAG_MAX_COUNT) {
    throw new ContentError(`At most ${HASHTAG_MAX_COUNT} hashtags are allowed`, {
      code: 'TOO_MANY_HASHTAGS',
      details: { count: result.length },
    });
  }

  return result;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeContentType(value) {
  const type = String(value ?? ContentType.IMAGE).trim().toUpperCase();
  if (!CONTENT_TYPES.includes(type)) {
    throw new ContentError(`Unsupported content type: ${value}`, {
      code: 'UNSUPPORTED_CONTENT_TYPE',
      details: { contentType: value },
    });
  }
  return type;
}

/**
 * @param {string} caption
 */
export function assertCaptionValid(caption) {
  if (caption.length > CAPTION_MAX_LENGTH) {
    throw new ContentError(
      `Caption exceeds Instagram limit of ${CAPTION_MAX_LENGTH} characters`,
      { code: 'CAPTION_TOO_LONG', details: { length: caption.length } },
    );
  }
}

/**
 * @param {string} title
 */
export function assertTitleValid(title) {
  if (title.length > TITLE_MAX_LENGTH) {
    throw new ContentError(`Title exceeds ${TITLE_MAX_LENGTH} characters`, {
      code: 'TITLE_TOO_LONG',
      details: { length: title.length },
    });
  }
}

/**
 * Validate media set against content type and adapter constraints.
 *
 * @param {string} contentType
 * @param {ReadonlyArray<{ mimeType: string, mediaKind: string, byteSize: number }>} media
 * @param {{
 *   supportedTypes?: ReadonlyArray<string>,
 *   constraints?: typeof MEDIA_CONSTRAINTS,
 *   storyConstraints?: typeof STORY_MEDIA_CONSTRAINTS,
 * }} [options]
 */
export function assertMediaMatchesType(contentType, media, options = {}) {
  const constraints = options.constraints ?? MEDIA_CONSTRAINTS;
  const supported = options.supportedTypes ?? CONTENT_TYPES;

  if (!supported.includes(contentType)) {
    throw new ContentError(
      `Content type ${contentType} is not enabled for the configured publishing adapter`,
      { code: 'CONTENT_TYPE_DISABLED', details: { contentType, supported } },
    );
  }

  if (!Array.isArray(media) || media.length === 0) {
    throw new ContentError('At least one media file is required', {
      code: 'MEDIA_REQUIRED',
    });
  }

  switch (contentType) {
    case ContentType.IMAGE:
      if (media.length !== 1 || media[0].mediaKind !== 'image') {
        throw new ContentError('IMAGE content requires exactly one image', {
          code: 'MEDIA_TYPE_MISMATCH',
        });
      }
      break;
    case ContentType.VIDEO:
      if (media.length !== 1 || media[0].mediaKind !== 'video') {
        throw new ContentError('VIDEO content requires exactly one video', {
          code: 'MEDIA_TYPE_MISMATCH',
        });
      }
      break;
    case ContentType.REEL:
      if (media.length !== 1 || media[0].mediaKind !== 'video') {
        throw new ContentError('REEL content requires exactly one video', {
          code: 'MEDIA_TYPE_MISMATCH',
        });
      }
      break;
    case ContentType.STORY:
      if (media.length !== 1) {
        throw new ContentError('STORY content requires exactly one media file', {
          code: 'MEDIA_TYPE_MISMATCH',
        });
      }
      // Story-specific MIME / duration / aspect rules (Meta Story specs).
      assertStoryMediaValid(/** @type {any} */ (media[0]), {
        constraints: options.storyConstraints ?? STORY_MEDIA_CONSTRAINTS,
      });
      // Skip generic feed MIME loop for Stories (JPEG-only vs feed PNG allowance).
      return;
    case ContentType.CAROUSEL:
      if (media.length < 2 || media.length > constraints.maxCarouselItems) {
        throw new ContentError(
          `CAROUSEL requires 2–${constraints.maxCarouselItems} media items`,
          { code: 'CAROUSEL_COUNT', details: { count: media.length } },
        );
      }
      break;
    default:
      throw new ContentError(`Unsupported content type: ${contentType}`, {
        code: 'UNSUPPORTED_CONTENT_TYPE',
      });
  }

  for (const item of media) {
    if (item.mediaKind === 'image') {
      if (!constraints.allowedImageMimeTypes.includes(item.mimeType)) {
        throw new ContentError(`Unsupported image MIME type: ${item.mimeType}`, {
          code: 'UNSUPPORTED_MIME',
          details: { mimeType: item.mimeType },
        });
      }
      if (item.byteSize > constraints.maxImageBytes) {
        throw new ContentError('Image exceeds maximum allowed size', {
          code: 'MEDIA_TOO_LARGE',
          details: { byteSize: item.byteSize, max: constraints.maxImageBytes },
        });
      }
    } else if (item.mediaKind === 'video') {
      if (!constraints.allowedVideoMimeTypes.includes(item.mimeType)) {
        throw new ContentError(`Unsupported video MIME type: ${item.mimeType}`, {
          code: 'UNSUPPORTED_MIME',
          details: { mimeType: item.mimeType },
        });
      }
      if (item.byteSize > constraints.maxVideoBytes) {
        throw new ContentError('Video exceeds maximum allowed size', {
          code: 'MEDIA_TOO_LARGE',
          details: { byteSize: item.byteSize, max: constraints.maxVideoBytes },
        });
      }
    } else {
      throw new ContentError(`Unsupported media kind: ${item.mediaKind}`, {
        code: 'UNSUPPORTED_MEDIA_KIND',
      });
    }
  }
}

/**
 * Fields required before approval / publishing.
 *
 * @param {{
 *   title?: string,
 *   caption?: string,
 *   contentType?: string,
 *   media?: ReadonlyArray<unknown>,
 * }} item
 * @param {{ requireCaption?: boolean }} [options]
 */
export function assertReadyForReview(item, options = {}) {
  const title = String(item.title ?? '').trim();
  if (!title) {
    throw new ContentError('Title is required before review', {
      code: 'TITLE_REQUIRED',
    });
  }
  assertTitleValid(title);

  const caption = normalizeCaption(item.caption);
  assertCaptionValid(caption);
  if (options.requireCaption !== false && !caption.trim()) {
    throw new ContentError('Caption is required before review', {
      code: 'CAPTION_REQUIRED',
    });
  }

  const contentType = normalizeContentType(item.contentType);
  assertMediaMatchesType(contentType, /** @type {any[]} */ (item.media ?? []));
}
