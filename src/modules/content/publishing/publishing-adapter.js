import {
  ContentError,
  ContentType,
  GRAPH_API_HOSTS,
  GRAPH_REQUIRED_PERMISSIONS,
  GraphLoginFlow,
  MEDIA_CONSTRAINTS,
  STORY_MEDIA_CONSTRAINTS,
} from '../constants.js';

/**
 * @typedef {object} PublishingCapabilities
 * @property {string} name
 * @property {boolean} isMock
 * @property {boolean} dryRunOnly
 * @property {ReadonlyArray<string>} supportedContentTypes
 * @property {typeof MEDIA_CONSTRAINTS} constraints
 * @property {ReadonlyArray<string>} requiredPermissions
 * @property {string} documentationUrl
 */

/**
 * @typedef {object} PublishRequest
 * @property {string} contentId
 * @property {string} contentType
 * @property {string} caption
 * @property {string[]} hashtags
 * @property {ReadonlyArray<{
 *   filePath: string,
 *   mimeType: string,
 *   mediaKind: string,
 *   byteSize: number,
 * }>} media
 * @property {string} idempotencyKey
 * @property {boolean} dryRun
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} PublishResult
 * @property {'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'DRY_RUN'} status
 * @property {boolean} simulated
 * @property {string | null} externalPublishId
 * @property {string | null} containerId
 * @property {string | null} requestId
 * @property {string} [message]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * Publishing adapter interface. Implementations must not scrape Instagram
 * or call undocumented private endpoints.
 *
 * @interface
 */
export class PublishingAdapter {
  /** @returns {PublishingCapabilities} */
  getCapabilities() {
    throw new Error('Not implemented');
  }

  /**
   * Validate account / token readiness without publishing.
   * @returns {Promise<{ ok: boolean, message: string, details?: Record<string, unknown> }>}
   */
  async validateAccount() {
    throw new Error('Not implemented');
  }

  /**
   * @param {PublishRequest} _request
   * @returns {Promise<PublishResult>}
   */
  async publish(_request) {
    throw new Error('Not implemented');
  }
}

/**
 * Development/testing adapter. Never labels results as real Instagram publications.
 */
export class MockPublishingAdapter extends PublishingAdapter {
  /**
   * @param {{
   *   failNext?: boolean,
   *   uncertainNext?: boolean,
   *   idFn?: () => string,
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.failNext = Boolean(options.failNext);
    this.uncertainNext = Boolean(options.uncertainNext);
    this._id = options.idFn ?? (() => `mock_${Date.now()}`);
    this.publishedKeys = new Set();
  }

  getCapabilities() {
    return {
      name: 'mock',
      isMock: true,
      dryRunOnly: false,
      supportedContentTypes: Object.values(ContentType),
      constraints: MEDIA_CONSTRAINTS,
      requiredPermissions: [],
      documentationUrl: 'local://mock-publishing-adapter',
    };
  }

  async validateAccount() {
    return {
      ok: true,
      message: 'Mock publishing adapter ready (simulated publications only)',
      details: { simulated: true },
    };
  }

  /**
   * @param {PublishRequest} request
   * @returns {Promise<PublishResult>}
   */
  async publish(request) {
    if (this.publishedKeys.has(request.idempotencyKey)) {
      return {
        status: 'SUCCEEDED',
        simulated: true,
        externalPublishId: `mock_dup_${request.idempotencyKey}`,
        containerId: null,
        requestId: this._id(),
        message: 'Duplicate idempotency key — returning prior simulated success',
        raw: { duplicate: true },
      };
    }

    if (request.dryRun) {
      return {
        status: 'DRY_RUN',
        simulated: true,
        externalPublishId: null,
        containerId: `dry_container_${request.contentId}`,
        requestId: this._id(),
        message: 'Dry-run only — no Instagram publication occurred',
        raw: { dryRun: true },
      };
    }

    if (this.uncertainNext) {
      this.uncertainNext = false;
      return {
        status: 'UNCERTAIN',
        simulated: true,
        externalPublishId: null,
        containerId: `mock_container_${request.contentId}`,
        requestId: this._id(),
        message: 'Publication result unknown (simulated timeout)',
        raw: { uncertain: true },
      };
    }

    if (this.failNext) {
      this.failNext = false;
      return {
        status: 'FAILED',
        simulated: true,
        externalPublishId: null,
        containerId: null,
        requestId: this._id(),
        message: 'Simulated publishing failure',
        raw: { failed: true },
      };
    }

    const externalId = `mock_pub_${this._id()}`;
    this.publishedKeys.add(request.idempotencyKey);
    return {
      status: 'SUCCEEDED',
      simulated: true,
      externalPublishId: externalId,
      containerId: `mock_container_${request.contentId}`,
      requestId: this._id(),
      message: 'Simulated publication succeeded (not a real Instagram post)',
      raw: { simulated: true },
    };
  }
}

/**
 * Official Meta Graph API publishing adapter (Instagram Content Publishing API).
 *
 * Supports two authentication models (do not mix):
 * - Facebook Login → `graph.facebook.com` + Page/User token +
 *   `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
 * - Instagram Login → `graph.instagram.com` + Instagram User token +
 *   `instagram_business_basic`, `instagram_business_content_publish`
 *
 * Media must be reachable via publicly accessible HTTPS URLs for the Graph API
 * container creation flow. Local-only files are rejected unless a media host URL
 * mapper is provided.
 *
 * @see https://developers.facebook.com/docs/instagram-platform/content-publishing/
 */
export class OfficialInstagramPublishingAdapter extends PublishingAdapter {
  /**
   * @param {{
   *   accessToken?: string | null,
   *   igUserId?: string | null,
   *   graphApiBaseUrl?: string,
   *   apiVersion?: string,
   *   loginFlow?: string,
   *   mediaPublicUrlResolver?: ((filePath: string) => Promise<string> | string) | { resolve: (filePath: string) => Promise<string> | string },
   *   fetchFn?: typeof fetch,
   *   nowFn?: () => Date,
   *   containerPollIntervalMs?: number,
   *   containerPollTimeoutMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.accessToken = options.accessToken ?? null;
    this.igUserId = options.igUserId ?? null;
    this.loginFlow = normalizeGraphLoginFlow(options.loginFlow);
    this.graphApiBaseUrl = (
      options.graphApiBaseUrl ?? GRAPH_API_HOSTS[this.loginFlow]
    ).replace(/\/$/, '');
    this.apiVersion = options.apiVersion ?? 'v21.0';
    this.mediaPublicUrlResolver = options.mediaPublicUrlResolver ?? null;
    this.fetchFn = options.fetchFn ?? fetch;
    this._now = options.nowFn ?? (() => new Date());
    this.containerPollIntervalMs = options.containerPollIntervalMs ?? 5_000;
    this.containerPollTimeoutMs = options.containerPollTimeoutMs ?? 5 * 60_000;
  }

  getCapabilities() {
    return {
      name: 'instagram-graph',
      isMock: false,
      dryRunOnly: !this.isConfigured(),
      supportedContentTypes: [
        ContentType.IMAGE,
        ContentType.VIDEO,
        ContentType.CAROUSEL,
        ContentType.REEL,
        ContentType.STORY,
      ],
      constraints: MEDIA_CONSTRAINTS,
      storyConstraints: STORY_MEDIA_CONSTRAINTS,
      requiredPermissions: [...GRAPH_REQUIRED_PERMISSIONS[this.loginFlow]],
      loginFlow: this.loginFlow,
      graphApiBaseUrl: this.graphApiBaseUrl,
      documentationUrl:
        'https://developers.facebook.com/docs/instagram-platform/content-publishing/',
    };
  }

  isConfigured() {
    return Boolean(this.accessToken && this.igUserId);
  }

  /**
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async resolveMediaUrl(filePath) {
    if (!this.mediaPublicUrlResolver) {
      throw new ContentError(
        'Official Instagram publishing requires publicly reachable media HTTPS URLs. Set MEDIA_PUBLIC_BASE_URL or use dry-run/mock.',
        { code: 'MEDIA_URL_REQUIRED' },
      );
    }
    const resolver = this.mediaPublicUrlResolver;
    const url =
      typeof resolver === 'function' ? await resolver(filePath) : await resolver.resolve(filePath);
    assertPublicHttpsUrl(url);
    return url;
  }

  async validateAccount() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        message:
          'Instagram Graph credentials missing. Set INSTAGRAM_GRAPH_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID, or use PUBLISHING_ADAPTER=mock / dry-run.',
        details: {
          hasAccessToken: Boolean(this.accessToken),
          hasIgUserId: Boolean(this.igUserId),
          loginFlow: this.loginFlow,
        },
      };
    }

    try {
      const url = new URL(
        `${this.graphApiBaseUrl}/${this.apiVersion}/${this.igUserId}`,
      );
      url.searchParams.set('fields', 'id,username,account_type');
      url.searchParams.set('access_token', this.accessToken);
      const response = await this.fetchFn(url);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = body?.error?.code;
        if (code === 190) {
          return {
            ok: false,
            message: 'Access token expired or invalid',
            details: { error: body.error, loginFlow: this.loginFlow },
          };
        }
        return {
          ok: false,
          message: body?.error?.message ?? `Graph API error HTTP ${response.status}`,
          details: { error: body.error ?? body, loginFlow: this.loginFlow },
        };
      }

      const accountType = String(body.account_type ?? '').toUpperCase();
      const professional =
        !accountType ||
        accountType === 'BUSINESS' ||
        accountType === 'MEDIA_CREATOR' ||
        accountType === 'CREATOR';

      if (accountType && !professional) {
        return {
          ok: false,
          message: `Connected Instagram account type "${accountType}" is not a supported Professional account for Content Publishing`,
          details: {
            id: body.id,
            username: body.username,
            accountType: body.account_type,
            loginFlow: this.loginFlow,
          },
        };
      }

      return {
        ok: true,
        message: `Instagram Graph account reachable (${body.username ?? body.id})`,
        details: {
          id: body.id,
          username: body.username,
          accountType: body.account_type ?? null,
          loginFlow: this.loginFlow,
          requiredPermissions: GRAPH_REQUIRED_PERMISSIONS[this.loginFlow],
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: `Failed to validate Instagram Graph account: ${error instanceof Error ? error.message : String(error)}`,
        details: { loginFlow: this.loginFlow },
      };
    }
  }

  /**
   * @param {PublishRequest} request
   * @returns {Promise<import('./publishing-adapter.js').PublishResult>}
   */
  async publish(request) {
    if (request.dryRun || !this.isConfigured()) {
      return {
        status: 'DRY_RUN',
        simulated: true,
        externalPublishId: null,
        containerId: null,
        requestId: `dry_${request.contentId}`,
        message: this.isConfigured()
          ? 'Dry-run — Instagram Graph publish skipped'
          : 'Official adapter not configured — dry-run only (not a real Instagram publication)',
        raw: { dryRun: true, configured: this.isConfigured() },
      };
    }

    try {
      if (request.contentType === ContentType.IMAGE) {
        return await this._publishSingleImage(request);
      }
      if (
        request.contentType === ContentType.VIDEO ||
        request.contentType === ContentType.REEL
      ) {
        return await this._publishVideo(request, request.contentType === ContentType.REEL);
      }
      if (request.contentType === ContentType.CAROUSEL) {
        return await this._publishCarousel(request);
      }
      if (request.contentType === ContentType.STORY) {
        return await this._publishStory(request);
      }
      throw new ContentError(`Unsupported content type for Graph API: ${request.contentType}`, {
        code: 'UNSUPPORTED_CONTENT_TYPE',
      });
    } catch (error) {
      if (error instanceof ContentError && error.code === 'PUBLISH_UNCERTAIN') {
        return {
          status: 'UNCERTAIN',
          simulated: false,
          externalPublishId: null,
          containerId: error.details?.containerId ?? null,
          requestId: error.details?.requestId ?? null,
          message: error.message,
          raw: error.details ?? {},
        };
      }
      if (error instanceof ContentError) {
        return {
          status: 'FAILED',
          simulated: false,
          externalPublishId: null,
          containerId: error.details?.containerId ?? null,
          requestId: error.details?.requestId ?? null,
          message: error.message,
          raw: error.details ?? {},
        };
      }
      // Network / abort / timeout after a container may have been created → uncertain
      return {
        status: 'UNCERTAIN',
        simulated: false,
        externalPublishId: null,
        containerId: null,
        requestId: null,
        message: error instanceof Error ? error.message : String(error),
        raw: { uncertain: true },
      };
    }
  }

  /**
   * @param {PublishRequest} request
   */
  async _publishSingleImage(request) {
    const imageUrl = await this.resolveMediaUrl(request.media[0].filePath);
    const container = await this._graphPost(`/${this.igUserId}/media`, {
      image_url: imageUrl,
      caption: this._composeCaption(request),
    });
    return this._publishContainer(container.id, request, { waitForFinished: false });
  }

  /**
   * @param {PublishRequest} request
   * @param {boolean} isReel
   */
  async _publishVideo(request, isReel) {
    const videoUrl = await this.resolveMediaUrl(request.media[0].filePath);
    /** @type {Record<string, string>} */
    const params = {
      video_url: videoUrl,
      caption: this._composeCaption(request),
      media_type: isReel ? 'REELS' : 'VIDEO',
    };
    const container = await this._graphPost(`/${this.igUserId}/media`, params);
    return this._publishContainer(container.id, request, { waitForFinished: true });
  }

  /**
   * @param {PublishRequest} request
   */
  async _publishCarousel(request) {
    const children = [];
    for (const item of request.media) {
      const url = await this.resolveMediaUrl(item.filePath);
      /** @type {Record<string, string>} */
      const params = { is_carousel_item: 'true' };
      if (item.mediaKind === 'image') {
        params.image_url = url;
      } else {
        params.video_url = url;
        params.media_type = 'VIDEO';
      }
      const child = await this._graphPost(`/${this.igUserId}/media`, params);
      if (item.mediaKind === 'video') {
        await this._waitForContainerFinished(child.id);
      }
      children.push(child.id);
    }
    const container = await this._graphPost(`/${this.igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption: this._composeCaption(request),
    });
    return this._publishContainer(container.id, request, { waitForFinished: false });
  }

  /**
   * Publish an Instagram Story via media_type=STORIES.
   * Stories do not accept captions/stickers via the public Content Publishing API.
   *
   * @param {PublishRequest} request
   */
  async _publishStory(request) {
    if (!request.media?.length) {
      throw new ContentError('Story publish requires media', { code: 'MEDIA_REQUIRED' });
    }
    const media = request.media[0];
    const url = await this.resolveMediaUrl(media.filePath);
    /** @type {Record<string, string>} */
    const params = { media_type: 'STORIES' };
    const isVideo = media.mediaKind === 'video';
    if (isVideo) {
      params.video_url = url;
    } else {
      params.image_url = url;
    }
    const container = await this._graphPost(`/${this.igUserId}/media`, params);
    return this._publishContainer(String(container.id), request, {
      waitForFinished: isVideo,
      verifyMediaProductType: true,
    });
  }

  /**
   * @param {string} containerId
   * @param {PublishRequest} request
   * @param {{ waitForFinished?: boolean, verifyMediaProductType?: boolean }} [options]
   */
  async _publishContainer(containerId, request, options = {}) {
    try {
      if (options.waitForFinished) {
        await this._waitForContainerFinished(containerId);
      }
      const published = await this._graphPost(`/${this.igUserId}/media_publish`, {
        creation_id: containerId,
      });
      const mediaId = published?.id != null ? String(published.id) : null;
      if (!mediaId) {
        throw new ContentError(
          'media_publish succeeded without returning an Instagram media id',
          {
            code: 'PUBLISH_UNCERTAIN',
            details: { containerId, requestId: request.idempotencyKey, raw: published },
          },
        );
      }

      /** @type {Record<string, unknown>} */
      let verification = { id: mediaId };
      if (options.verifyMediaProductType) {
        verification = await this._verifyPublishedMedia(mediaId);
      }

      return {
        status: 'SUCCEEDED',
        simulated: false,
        externalPublishId: mediaId,
        containerId: String(containerId),
        requestId: request.idempotencyKey,
        message: 'Published via Instagram Graph API',
        raw: { published, verification },
      };
    } catch (error) {
      if (error instanceof ContentError && error.code === 'PUBLISH_UNCERTAIN') {
        throw error;
      }
      if (
        error instanceof ContentError &&
        (error.code === 'TOKEN_EXPIRED' ||
          error.code === 'PERMISSION_DENIED' ||
          error.code === 'RATE_LIMITED' ||
          error.code === 'GRAPH_API_ERROR' ||
          error.code === 'CONTAINER_ERROR')
      ) {
        throw error;
      }
      throw new ContentError(
        error instanceof Error ? error.message : String(error),
        {
          code: 'PUBLISH_UNCERTAIN',
          details: { containerId, requestId: request.idempotencyKey },
          cause: error,
        },
      );
    }
  }

  /**
   * Poll container status_code until FINISHED (required for video Stories / Reels).
   *
   * @param {string} containerId
   */
  async _waitForContainerFinished(containerId) {
    const started = this._now().getTime();
    while (this._now().getTime() - started < this.containerPollTimeoutMs) {
      const status = await this._graphGet(`/${containerId}`, {
        fields: 'status_code,status',
      });
      const code = String(status.status_code ?? '').toUpperCase();
      if (code === 'FINISHED') {
        return status;
      }
      if (code === 'ERROR' || code === 'EXPIRED') {
        throw new ContentError(
          `Media container ${containerId} entered status ${code}`,
          {
            code: 'CONTAINER_ERROR',
            details: { containerId, status },
          },
        );
      }
      await sleep(this.containerPollIntervalMs);
    }
    throw new ContentError(
      `Timed out waiting for media container ${containerId} to become publishable`,
      {
        code: 'PUBLISH_UNCERTAIN',
        details: { containerId },
      },
    );
  }

  /**
   * Verify a published media object. For Stories, media_type returns IMAGE/VIDEO;
   * media_product_type should identify STORIES when available.
   *
   * @param {string} mediaId
   */
  async _verifyPublishedMedia(mediaId) {
    try {
      return await this._graphGet(`/${mediaId}`, {
        fields: 'id,media_type,media_product_type,timestamp',
      });
    } catch (error) {
      // Verification failure after publish is uncertain — do not invent success claims.
      throw new ContentError(
        `Published media id ${mediaId} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'PUBLISH_UNCERTAIN',
          details: { mediaId },
          cause: error,
        },
      );
    }
  }

  /**
   * @param {PublishRequest} request
   */
  _composeCaption(request) {
    const tags = (request.hashtags ?? []).join(' ');
    const caption = String(request.caption ?? '');
    if (!tags) {
      return caption;
    }
    if (!caption) {
      return tags;
    }
    return `${caption}\n\n${tags}`;
  }

  /**
   * @param {string} pathSuffix
   * @param {Record<string, string>} params
   */
  async _graphPost(pathSuffix, params) {
    const url = new URL(`${this.graphApiBaseUrl}/${this.apiVersion}${pathSuffix}`);
    const body = new URLSearchParams({ ...params, access_token: this.accessToken });
    let response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      throw new ContentError(
        `Graph API network error: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'PUBLISH_UNCERTAIN', cause: error },
      );
    }

    return this._handleGraphResponse(response);
  }

  /**
   * @param {string} pathSuffix
   * @param {Record<string, string>} [query]
   */
  async _graphGet(pathSuffix, query = {}) {
    const url = new URL(`${this.graphApiBaseUrl}/${this.apiVersion}${pathSuffix}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('access_token', this.accessToken);
    let response;
    try {
      response = await this.fetchFn(url, { method: 'GET' });
    } catch (error) {
      throw new ContentError(
        `Graph API network error: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'PUBLISH_UNCERTAIN', cause: error },
      );
    }
    return this._handleGraphResponse(response);
  }

  /**
   * @param {Response} response
   */
  async _handleGraphResponse(response) {
    const retryAfter = response.headers?.get?.('retry-after');
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message ?? `Graph API HTTP ${response.status}`;
      const code = json?.error?.code;
      const subcode = json?.error?.error_subcode;
      if (code === 190) {
        throw new ContentError('Access token expired or invalid', {
          code: 'TOKEN_EXPIRED',
          details: { error: json.error },
        });
      }
      if (
        code === 10 ||
        code === 200 ||
        subcode === 33 ||
        /permission|not authorized|insufficient/i.test(String(message))
      ) {
        throw new ContentError(`Instagram API permission failure: ${message}`, {
          code: 'PERMISSION_DENIED',
          details: { error: json.error, httpStatus: response.status },
        });
      }
      if (response.status === 429 || code === 4 || code === 17) {
        throw new ContentError(`Instagram platform rate limit: ${message}`, {
          code: 'RATE_LIMITED',
          details: {
            error: json.error,
            retryAfter: retryAfter ?? null,
          },
        });
      }
      throw new ContentError(message, {
        code: 'GRAPH_API_ERROR',
        details: { error: json.error ?? json, httpStatus: response.status },
      });
    }
    return json;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeGraphLoginFlow(value) {
  const normalized = String(value ?? GraphLoginFlow.FACEBOOK)
    .trim()
    .toLowerCase();
  if (normalized === 'instagram' || normalized === 'instagram-login') {
    return GraphLoginFlow.INSTAGRAM;
  }
  if (
    normalized === 'facebook' ||
    normalized === 'facebook-login' ||
    normalized === 'pages'
  ) {
    return GraphLoginFlow.FACEBOOK;
  }
  throw new ContentError(
    `Unsupported INSTAGRAM_GRAPH_LOGIN_FLOW: ${value}. Expected facebook or instagram.`,
    { code: 'INVALID_LOGIN_FLOW' },
  );
}

/**
 * @param {string} url
 */
function assertPublicHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ContentError(`Media URL is not a valid absolute URL: ${url}`, {
      code: 'MEDIA_URL_INVALID',
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new ContentError(
      `Media URL must be HTTPS (got ${parsed.protocol}). Instagram Graph rejects non-HTTPS media URLs.`,
      { code: 'MEDIA_URL_HTTPS_REQUIRED', details: { url } },
    );
  }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{
 *   adapter?: string,
 *   accessToken?: string | null,
 *   igUserId?: string | null,
 *   loginFlow?: string,
 *   graphApiBaseUrl?: string | null,
 *   apiVersion?: string,
 *   mediaPublicUrlResolver?: ((filePath: string) => Promise<string> | string) | { resolve: (filePath: string) => Promise<string> | string },
 *   fetchFn?: typeof fetch,
 *   containerPollIntervalMs?: number,
 *   containerPollTimeoutMs?: number,
 * }} config
 * @returns {PublishingAdapter}
 */
export function createPublishingAdapter(config = {}) {
  const name = String(config.adapter ?? 'mock').toLowerCase();
  if (name === 'instagram-graph' || name === 'instagram' || name === 'official') {
    return new OfficialInstagramPublishingAdapter({
      accessToken: config.accessToken,
      igUserId: config.igUserId,
      loginFlow: config.loginFlow,
      graphApiBaseUrl: config.graphApiBaseUrl ?? undefined,
      apiVersion: config.apiVersion,
      mediaPublicUrlResolver: config.mediaPublicUrlResolver,
      fetchFn: config.fetchFn,
      containerPollIntervalMs: config.containerPollIntervalMs,
      containerPollTimeoutMs: config.containerPollTimeoutMs,
    });
  }
  return new MockPublishingAdapter();
}
