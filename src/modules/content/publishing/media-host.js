import path from 'node:path';
import { ContentError } from '../constants.js';

/**
 * Resolve local media library paths to publicly reachable HTTPS URLs
 * required by the Instagram Content Publishing API (image_url / video_url).
 *
 * @interface
 */
export class MediaPublicUrlResolver {
  /**
   * @param {string} _filePath
   * @returns {Promise<string> | string}
   */
  resolve(_filePath) {
    throw new Error('Not implemented');
  }

  /**
   * @returns {{ configured: boolean, mode: string, message: string }}
   */
  getStatus() {
    throw new Error('Not implemented');
  }
}

/**
 * Maps files under the local media library to `{baseUrl}/{relativePath}`.
 *
 * Deployment prerequisite: the media library (or a synced copy) must be served
 * over publicly reachable HTTPS. This resolver does not host files itself.
 */
export class BaseUrlMediaHost extends MediaPublicUrlResolver {
  /**
   * @param {{
   *   baseUrl: string,
   *   mediaLibraryDir: string,
   * }} options
   */
  constructor(options) {
    super();
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.mediaLibraryDir = path.resolve(options.mediaLibraryDir);

    let parsed;
    try {
      parsed = new URL(this.baseUrl);
    } catch {
      throw new ContentError(`Invalid MEDIA_PUBLIC_BASE_URL: ${options.baseUrl}`, {
        code: 'MEDIA_HOST_INVALID',
      });
    }
    if (parsed.protocol !== 'https:') {
      throw new ContentError(
        'MEDIA_PUBLIC_BASE_URL must use HTTPS (Instagram Graph requires publicly reachable HTTPS media URLs)',
        { code: 'MEDIA_HOST_HTTPS_REQUIRED', details: { baseUrl: this.baseUrl } },
      );
    }
  }

  /**
   * @param {string} filePath
   * @returns {string}
   */
  resolve(filePath) {
    const absolute = path.resolve(filePath);
    const relative = path.relative(this.mediaLibraryDir, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ContentError(
        'Media file is outside the configured media library and cannot be mapped to a public URL',
        {
          code: 'MEDIA_HOST_PATH_OUTSIDE_LIBRARY',
          details: { filePath: absolute, mediaLibraryDir: this.mediaLibraryDir },
        },
      );
    }
    const urlPath = relative.split(path.sep).map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${urlPath}`;
  }

  getStatus() {
    return {
      configured: true,
      mode: 'base-url',
      message: `Media URLs resolve under ${this.baseUrl}/ (ensure this origin serves the media library over HTTPS)`,
    };
  }
}

/**
 * Explicit unresolved host — surfaces a clear deployment prerequisite.
 */
export class MissingMediaHost extends MediaPublicUrlResolver {
  getStatus() {
    return {
      configured: false,
      mode: 'missing',
      message:
        'MEDIA_PUBLIC_BASE_URL is not set. Official Graph Story publishing requires publicly reachable HTTPS media URLs. Set MEDIA_PUBLIC_BASE_URL to an HTTPS origin that serves MEDIA_LIBRARY_DIR, or use PUBLISHING_ADAPTER=mock / CONTENT_DRY_RUN=true.',
    };
  }

  /**
   * @param {string} _filePath
   */
  resolve(_filePath) {
    throw new ContentError(this.getStatus().message, {
      code: 'MEDIA_URL_REQUIRED',
    });
  }
}

/**
 * @param {{
 *   mediaPublicBaseUrl?: string | null,
 *   mediaLibraryDir: string,
 * }} config
 * @returns {MediaPublicUrlResolver}
 */
export function createMediaPublicUrlResolver(config) {
  const baseUrl = config.mediaPublicBaseUrl?.trim() || '';
  if (!baseUrl) {
    return new MissingMediaHost();
  }
  return new BaseUrlMediaHost({
    baseUrl,
    mediaLibraryDir: config.mediaLibraryDir,
  });
}
