import { describe, expect, it } from 'vitest';
import {
  MockPublishingAdapter,
  OfficialInstagramPublishingAdapter,
  createPublishingAdapter,
} from '../../src/modules/content/publishing/publishing-adapter.js';

describe('publishing adapters', () => {
  it('mock adapter simulates success and marks simulated', async () => {
    const adapter = new MockPublishingAdapter({ idFn: () => 'fixed' });
    const result = await adapter.publish({
      contentId: 'c1',
      contentType: 'IMAGE',
      caption: 'hi',
      hashtags: [],
      media: [{ filePath: '/tmp/a.jpg', mimeType: 'image/jpeg', mediaKind: 'image', byteSize: 1 }],
      idempotencyKey: 'k1',
      dryRun: false,
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.simulated).toBe(true);
    expect(result.message).toMatch(/not a real Instagram/i);
  });

  it('official adapter dry-runs when credentials missing', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({});
    expect(adapter.getCapabilities().isMock).toBe(false);
    expect(adapter.getCapabilities().dryRunOnly).toBe(true);
    const validation = await adapter.validateAccount();
    expect(validation.ok).toBe(false);

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: 'IMAGE',
      caption: 'hi',
      hashtags: [],
      media: [{ filePath: '/tmp/a.jpg', mimeType: 'image/jpeg', mediaKind: 'image', byteSize: 1 }],
      idempotencyKey: 'k1',
      dryRun: false,
    });
    expect(result.status).toBe('DRY_RUN');
    expect(result.simulated).toBe(true);
  });

  it('official adapter validates token expiry from Graph responses', async () => {
    const adapter = new OfficialInstagramPublishingAdapter({
      accessToken: 'token',
      igUserId: '17841400000000000',
      fetchFn: async () =>
        ({
          ok: false,
          json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token.' } }),
        }),
    });
    const validation = await adapter.validateAccount();
    expect(validation.ok).toBe(false);
    expect(validation.message).toMatch(/expired|invalid/i);
  });

  it('factory selects adapters', () => {
    expect(createPublishingAdapter({ adapter: 'mock' })).toBeInstanceOf(MockPublishingAdapter);
    expect(createPublishingAdapter({ adapter: 'instagram-graph' })).toBeInstanceOf(
      OfficialInstagramPublishingAdapter,
    );
  });
});
