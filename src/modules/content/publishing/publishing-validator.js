import { ContentError, ContentStatus, ApprovalStatus } from '../constants.js';
import { hasValidApproval, isPublishableStatus } from '../content-state-machine.js';
import { assertMediaMatchesType, assertCaptionValid } from '../content-validator.js';

/**
 * @param {object} content
 * @param {{
 *   supportedTypes?: ReadonlyArray<string>,
 *   requireConfirm?: boolean,
 *   confirm?: boolean,
 *   allowImmediate?: boolean,
 * }} [options]
 */
export function assertCanPublish(content, options = {}) {
  if (!content) {
    throw new ContentError('Content not found', { code: 'CONTENT_NOT_FOUND' });
  }

  if (content.status === ContentStatus.PUBLISHED && content.externalPublishId) {
    throw new ContentError('Content is already published', {
      code: 'ALREADY_PUBLISHED',
      details: { externalPublishId: content.externalPublishId },
    });
  }

  if (!isPublishableStatus(content.status) && content.status !== ContentStatus.PUBLISHING) {
    throw new ContentError(
      `Content status ${content.status} is not eligible for publishing`,
      { code: 'NOT_PUBLISHABLE', details: { status: content.status } },
    );
  }

  if (!hasValidApproval(content.approvalStatus)) {
    throw new ContentError('Content must be explicitly approved before publishing', {
      code: 'APPROVAL_REQUIRED',
      details: { approvalStatus: content.approvalStatus },
    });
  }

  if (content.approvalStatus === ApprovalStatus.INVALIDATED) {
    throw new ContentError('Previous approval was invalidated; re-approve before publishing', {
      code: 'APPROVAL_INVALIDATED',
    });
  }

  assertCaptionValid(String(content.caption ?? ''));
  assertMediaMatchesType(content.contentType, content.media ?? [], {
    supportedTypes: options.supportedTypes,
  });

  if (options.requireConfirm && !options.confirm) {
    throw new ContentError(
      'Immediate publishing requires explicit confirmation (--confirm)',
      { code: 'CONFIRMATION_REQUIRED' },
    );
  }
}
