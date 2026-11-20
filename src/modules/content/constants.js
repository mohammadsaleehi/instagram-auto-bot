/**
 * Content management domain constants.
 */

export const ContentType = Object.freeze({
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  CAROUSEL: 'CAROUSEL',
  REEL: 'REEL',
  STORY: 'STORY',
});

export const CONTENT_TYPES = Object.freeze(Object.values(ContentType));

/**
 * Publishing lifecycle states for a content item.
 */
export const ContentStatus = Object.freeze({
  DRAFT: 'DRAFT',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SCHEDULED: 'SCHEDULED',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
  CANCELLED: 'CANCELLED',
  /** Story-only: Instagram Stories expire ~24h after publication. */
  EXPIRED: 'EXPIRED',
});

/**
 * Story slide media kinds (mapped to Graph image_url / video_url).
 * Distinct from feed ContentType — Stories always use contentType=STORY.
 */
export const StoryMediaType = Object.freeze({
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
});

export const STORY_MEDIA_TYPES = Object.freeze(Object.values(StoryMediaType));

/** Instagram Stories remain active for 24 hours after publication. */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;

export const CONTENT_STATUSES = Object.freeze(Object.values(ContentStatus));

export const ApprovalStatus = Object.freeze({
  NONE: 'NONE',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  INVALIDATED: 'INVALIDATED',
});

export const APPROVAL_STATUSES = Object.freeze(Object.values(ApprovalStatus));

export const ApprovalAction = Object.freeze({
  SUBMIT_FOR_REVIEW: 'SUBMIT_FOR_REVIEW',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  INVALIDATE: 'INVALIDATE',
});

export const PublishingAttemptStatus = Object.freeze({
  STARTED: 'STARTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
  DRY_RUN: 'DRY_RUN',
  CANCELLED: 'CANCELLED',
});

export const CONTENT_PUBLISH_TASK_TYPE = 'content.publish';

export const DEFAULT_MEDIA_LIBRARY_DIR = './data/media';

/** Operator drop-zone for browser Story publishing (pending / published / failed). */
export const DEFAULT_STORY_MEDIA_DIR = './media/stories';

/** Conservative defaults aligned with Instagram Graph publishing docs. */
export const MEDIA_CONSTRAINTS = Object.freeze({
  maxImageBytes: 8 * 1024 * 1024,
  maxVideoBytes: 100 * 1024 * 1024,
  maxCarouselItems: 10,
  allowedImageMimeTypes: Object.freeze(['image/jpeg', 'image/png']),
  allowedVideoMimeTypes: Object.freeze(['video/mp4', 'video/quicktime']),
});

/**
 * Story media constraints from Meta IG User Media reference
 * (Story Image / Story Video Specifications).
 * Aspect ratio for images is recommended (not hard-required) by Meta.
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
 */
export const STORY_MEDIA_CONSTRAINTS = Object.freeze({
  maxImageBytes: 8 * 1024 * 1024,
  maxVideoBytes: 100 * 1024 * 1024,
  allowedImageMimeTypes: Object.freeze(['image/jpeg']),
  allowedVideoMimeTypes: Object.freeze(['video/mp4', 'video/quicktime']),
  /** Recommended Story aspect ratio (Meta: recommend 9:16). */
  recommendedAspectRatio: 9 / 16,
  /** Soft tolerance around recommended ratio when enforceRecommendedAspect is enabled. */
  recommendedAspectTolerance: 0.08,
  /** Story video duration bounds (Meta: 3s min, 60s max). */
  minVideoDurationMs: 3_000,
  maxVideoDurationMs: 60_000,
  /** Story video aspect ratio hard bounds (Meta: 0.1:1 to 10:1). */
  minVideoAspectRatio: 0.1,
  maxVideoAspectRatio: 10,
  /** Maximum horizontal pixels for Story video (Meta). */
  maxVideoWidth: 1920,
  /** When true, reject Story images far from 9:16. Default false (Meta: recommended only). */
  enforceRecommendedAspect: false,
});

/**
 * Browser UI Story upload accepts JPEG and PNG in practice.
 * Phase 1 browser publishing uses these constraints (not Graph JPEG-only).
 */
export const BROWSER_STORY_MEDIA_CONSTRAINTS = Object.freeze({
  ...STORY_MEDIA_CONSTRAINTS,
  allowedImageMimeTypes: Object.freeze(['image/jpeg', 'image/png']),
});

/**
 * Graph API authentication models for Content Publishing.
 * Do not mix hosts, tokens, or permissions across flows.
 */
export const GraphLoginFlow = Object.freeze({
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
});

export const GRAPH_LOGIN_FLOWS = Object.freeze(Object.values(GraphLoginFlow));

export const GRAPH_API_HOSTS = Object.freeze({
  [GraphLoginFlow.FACEBOOK]: 'https://graph.facebook.com',
  [GraphLoginFlow.INSTAGRAM]: 'https://graph.instagram.com',
});

export const GRAPH_REQUIRED_PERMISSIONS = Object.freeze({
  [GraphLoginFlow.FACEBOOK]: Object.freeze([
    'instagram_basic',
    'instagram_content_publish',
    'pages_read_engagement',
  ]),
  [GraphLoginFlow.INSTAGRAM]: Object.freeze([
    'instagram_business_basic',
    'instagram_business_content_publish',
  ]),
});

export class ContentError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ContentError';
    this.code = options.code ?? 'CONTENT_ERROR';
    this.details = options.details;
  }
}
