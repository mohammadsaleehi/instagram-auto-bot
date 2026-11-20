import { describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { ContentRepository } from '../../src/modules/content/content-repository.js';
import { PublishingService } from '../../src/modules/content/publishing/publishing-service.js';
import {
  ApprovalStatus,
  BROWSER_STORY_MEDIA_CONSTRAINTS,
  ContentStatus,
  ContentType,
} from '../../src/modules/content/constants.js';

describe('PublishingService dry-run-only gate', () => {
  it('cannot promote a dryRunOnly adapter by passing dryRun: false', async () => {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    try {
      const repository = new ContentRepository(database, {
        nowFn: () => new Date('2026-11-19T12:00:00.000Z'),
      });
      const content = repository.create({
        id: 'story-dry-only',
        contentType: ContentType.STORY,
        caption: '',
        status: ContentStatus.APPROVED,
        approvalStatus: ApprovalStatus.APPROVED,
      });
      repository.replaceMedia(content.id, [
        {
          filePath: '/tmp/story.jpg',
          originalName: 'story.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          byteSize: 1024,
          checksumSha256: 'abc',
          width: 1080,
          height: 1920,
        },
      ]);

      const requests = [];
      const adapter = {
        getCapabilities: () => ({
          name: 'dry-only',
          isMock: false,
          dryRunOnly: true,
          supportedContentTypes: [ContentType.STORY],
          constraints: BROWSER_STORY_MEDIA_CONSTRAINTS,
          requiredPermissions: [],
          documentationUrl: 'local://dry-only',
        }),
        validateAccount: async () => ({ ok: true, message: 'ready' }),
        publish: async (request) => {
          requests.push(request);
          return {
            status: 'DRY_RUN',
            simulated: true,
            externalPublishId: null,
            containerId: 'dry',
            requestId: 'req',
            message: 'dry-run forced',
            raw: { dryRun: true },
          };
        },
      };

      const service = new PublishingService({
        repository,
        adapter,
        dryRunDefault: false,
        nowFn: () => new Date('2026-11-19T12:00:00.000Z'),
      });

      const result = await service.publishContent(content.id, {
        dryRun: false,
        confirm: true,
        immediate: true,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].dryRun).toBe(true);
      expect(result.attempt.status).toBe('DRY_RUN');
      expect(result.attempt.dryRun).toBe(true);
      expect(result.content?.status).toBe(ContentStatus.APPROVED);
      expect(result.content?.externalPublishId).toBeNull();
    } finally {
      database.close();
    }
  });
});
