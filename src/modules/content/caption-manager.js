import { normalizeCaption, normalizeHashtags, assertCaptionValid } from './content-validator.js';

/**
 * Caption and hashtag helpers. Does not auto-generate marketing claims.
 */
export class CaptionManager {
  /**
   * @param {unknown} caption
   * @param {unknown} [hashtags]
   * @returns {{ caption: string, hashtags: string[], preview: string }}
   */
  compose(caption, hashtags) {
    const normalizedCaption = normalizeCaption(caption);
    assertCaptionValid(normalizedCaption);
    const tags = normalizeHashtags(hashtags);
    const preview = this.buildPreview(normalizedCaption, tags);
    return { caption: normalizedCaption, hashtags: tags, preview };
  }

  /**
   * Merge caption body with hashtags for publishing preview only.
   * Hashtags already present in the caption are not duplicated.
   *
   * @param {string} caption
   * @param {ReadonlyArray<string>} hashtags
   * @returns {string}
   */
  buildPreview(caption, hashtags) {
    const body = normalizeCaption(caption);
    const tags = normalizeHashtags(hashtags);
    if (tags.length === 0) {
      return body;
    }

    const lower = body.toLowerCase();
    const missing = tags.filter((tag) => !lower.includes(tag.toLowerCase()));
    if (missing.length === 0) {
      return body;
    }

    const spacer = body && !body.endsWith('\n') ? '\n\n' : body ? '\n' : '';
    return `${body}${spacer}${missing.join(' ')}`.trimEnd();
  }

  /**
   * Optional draft suggestion helpers stay separate from approved content.
   * Returns empty suggestions by default (no auto-hashtag injection).
   *
   * @param {string} _caption
   * @returns {{ suggestedHashtags: string[], notes: string }}
   */
  suggest(_caption) {
    return {
      suggestedHashtags: [],
      notes: 'Caption suggestions are not auto-applied; review and set hashtags explicitly.',
    };
  }
}
