import { describe, expect, it } from 'vitest';
import {
  OfficialInstagramPublishingAdapter,
  createPublishingAdapter,
} from '../../src/modules/content/publishing/publishing-adapter.js';
import {
  BaseUrlMediaHost,
  MissingMediaHost,
  createMediaPublicUrlResolver,
} from '../../src/modules/content/publishing/media-host.js';
import { ContentError, GraphLoginFlow } from '../../src/modules/content/constants.js';

describe('Story publishing adapter', () => {
  it('uses Facebook Login host and permissions by default', () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
    });
    const caps = adapter.getCapabilities();
    expect(caps.loginFlow).toBe(GraphLoginFlow.FACEBOOK);
    expect(caps.graphApiBaseUrl).toBe('https://graph.facebook.com');
    expect(caps.requiredPermissions).toEqual([
      'instagram_basic',
      'instagram_content_publish',
      'pages_read_engagement',
    ]);
    expect(caps.supportedContentTypes).toContain('STORY');
  });

  it('uses Instagram Login host and permissions when configured', () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      loginFlow: 'instagram',
    });
    const caps = adapter.getCapabilities();
    expect(caps.loginFlow).toBe(GraphLoginFlow.INSTAGRAM);
    expect(caps.graphApiBaseUrl).toBe('https://graph.instagram.com');
    expect(caps.requiredPermissions).toEqual([
      'instagram_business_basic',
      'instagram_business_content_publish',
    ]);
  });

  it('rejects missing public HTTPS media URL', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      mediaPublicUrlResolver: new MissingMediaHost(),
    });

    const result = await adapter.publish({
      contentId: 's1',
      contentType: 'STORY',
      caption: '',
      hashtags: [],
      media: [
        {
          filePath: '/tmp/story.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 10,
        },
      ],
      idempotencyKey: 'story-1',
      dryRun: false,
    });
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/MEDIA_PUBLIC_BASE_URL|HTTPS/i);
  });

  it('publishes IMAGE Stories with media_type=STORIES and polls VIDEO containers', async () => {
    /** @type {string[]} */
    const calls = [];
    let pollCount = 0;

    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      mediaPublicUrlResolver: async () => 'https://cdn.example.com/story.mp4',
      containerPollIntervalMs: 1,
      containerPollTimeoutMs: 1000,
      fetchFn: async (url, init) => {
        const href = String(url);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${href}`);

        if (method === 'POST' && href.includes('/media_publish')) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({ id: 'media_story_99' }),
          };
        }
        if (method === 'POST' && href.includes('/media')) {
          const body = String(init?.body ?? '');
          expect(body).toContain('media_type=STORIES');
          expect(body).toContain('video_url=');
          expect(body).not.toContain('caption=');
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({ id: 'container_story_1' }),
          };
        }
        if (method === 'GET' && href.includes('container_story_1')) {
          pollCount += 1;
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({
              status_code: pollCount >= 2 ? 'FINISHED' : 'IN_PROGRESS',
            }),
          };
        }
        if (method === 'GET' && href.includes('media_story_99')) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({
              id: 'media_story_99',
              media_type: 'VIDEO',
              media_product_type: 'STORY',
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      },
    });

    const result = await adapter.publish({
      contentId: 's-video',
      contentType: 'STORY',
      caption: '',
      hashtags: [],
      media: [
        {
          filePath: '/library/story.mp4',
          mimeType: 'video/mp4',
          mediaKind: 'video',
          byteSize: 1000,
        },
      ],
      idempotencyKey: 'story-video-1',
      dryRun: false,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.simulated).toBe(false);
    expect(result.externalPublishId).toBe('media_story_99');
    expect(result.containerId).toBe('container_story_1');
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('publishes IMAGE Stories without caption and verifies media id', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      mediaPublicUrlResolver: async () => 'https://cdn.example.com/story.jpg',
      fetchFn: async (url, init) => {
        const href = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'POST' && href.includes('/media') && !href.includes('media_publish')) {
          const body = String(init?.body ?? '');
          expect(body).toContain('media_type=STORIES');
          expect(body).toContain('image_url=');
          expect(body).not.toContain('caption=');
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({ id: 'container_img' }),
          };
        }
        if (method === 'POST' && href.includes('/media_publish')) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({ id: 'media_img_1' }),
          };
        }
        if (method === 'GET' && href.includes('media_img_1')) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({
              id: 'media_img_1',
              media_type: 'IMAGE',
              media_product_type: 'STORY',
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${method} ${href}`);
      },
    });

    const result = await adapter.publish({
      contentId: 's-image',
      contentType: 'STORY',
      caption: '',
      hashtags: [],
      media: [
        {
          filePath: '/library/story.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 100,
        },
      ],
      idempotencyKey: 'story-image-1',
      dryRun: false,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.externalPublishId).toBe('media_img_1');
  });

  it('maps token expiry failures', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      mediaPublicUrlResolver: async () => 'https://cdn.example.com/story.jpg',
      fetchFn: async () => ({
        ok: false,
        headers: { get: () => null },
        json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token.' } }),
      }),
    });

    const result = await adapter.publish({
      contentId: 's1',
      contentType: 'STORY',
      caption: '',
      hashtags: [],
      media: [
        {
          filePath: '/library/story.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 10,
        },
      ],
      idempotencyKey: 'story-token',
      dryRun: false,
    });
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/expired|invalid/i);
  });

  it('maps API permission failures without treating them as uncertain', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      mediaPublicUrlResolver: async () => 'https://cdn.example.com/story.jpg',
      fetchFn: async () => ({
        ok: false,
        headers: { get: () => null },
        json: async () => ({
          error: {
            code: 10,
            message: '(#10) Application does not have permission for this action',
          },
        }),
      }),
    });

    const result = await adapter.publish({
      contentId: 's-perm',
      contentType: 'STORY',
      caption: '',
      hashtags: [],
      media: [
        {
          filePath: '/library/story.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 10,
        },
      ],
      idempotencyKey: 'story-perm',
      dryRun: false,
    });
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/permission/i);
  });

  it('rejects non-professional accounts during validation', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      fetchFn: async () => ({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          id: '17841400000000000',
          username: 'personal_user',
          account_type: 'PERSONAL',
        }),
      }),
    });
    const validation = await adapter.validateAccount();
    expect(validation.ok).toBe(false);
    expect(validation.message).toMatch(/Professional/i);
  });

  it('creates BaseUrl media host and rejects http', () => {
    const host = createMediaPublicUrlResolver({
      mediaPublicBaseUrl: 'https://cdn.example.com/media',
      mediaLibraryDir: '/data/media',
    });
    expect(host).toBeInstanceOf(BaseUrlMediaHost);
    expect(host.resolve('/data/media/ab/file.jpg')).toBe(
      'https://cdn.example.com/media/ab/file.jpg',
    );

    expect(() =>
      createMediaPublicUrlResolver({
        mediaPublicBaseUrl: 'http://cdn.example.com/media',
        mediaLibraryDir: '/data/media',
      }),
    ).toThrow(ContentError);
  });

  it('factory still selects official adapter', () => {
    expect(
      createPublishingAdapter({
        adapter: 'instagram-graph',
        loginFlow: 'instagram',
      }),
    ).toBeInstanceOf(OfficialInstagramPublishingAdapter);
  });
});
