/**
 * Backward-compatible Story state exports.
 *
 * Canonical definitions live in `story/story-states.js`. Legacy property names
 * are aliased so older diagnostics and tests continue to resolve, but new code
 * must use the canonical names.
 */
import {
  DEFAULT_STORY_TIMEOUTS,
  STORY_FAILURE_CODES,
  STORY_LEGACY_STATE_ALIASES,
  STORY_STATE_TIMEOUTS,
  StoryPublishState as CanonicalStoryPublishState,
} from './story/story-states.js';

export const StoryPublishState = Object.freeze({
  ...CanonicalStoryPublishState,
  ...STORY_LEGACY_STATE_ALIASES,
});

export {
  DEFAULT_STORY_TIMEOUTS,
  STORY_FAILURE_CODES,
  STORY_STATE_TIMEOUTS,
  STORY_LEGACY_STATE_ALIASES,
};
