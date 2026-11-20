import { PublicationOutcome } from './publication-outcomes.js';
import {
  classifyPublicationFailure,
  failureCodeFromError,
} from './publication-failure-classification.js';

export const PUBLICATION_ADAPTER_CONTRACT_VERSION = 1;

export const AdapterExecutionStatus = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED',
});

/**
 * Normalize a modern or legacy adapter result into the common contract.
 *
 * Legacy adapters are still supported, but the normalized result always
 * separates execution status from publication outcome.
 *
 * @param {Record<string, any>} result
 * @param {{ caps?: Record<string, any>|null, contentId?: string|null, operationId?: string|null }} [context]
 */
export function normalizeAdapterResult(result = {}, context = {}) {
  const caps = context.caps ?? {};
  const simulated = Boolean(result.simulated) || Boolean(caps.isMock);
  const publicationOutcome =
    result.publication?.outcome ??
    (result.status === 'SUCCEEDED'
      ? PublicationOutcome.PUBLICATION_CONFIRMED
      : result.status === 'UNCERTAIN'
        ? PublicationOutcome.PUBLICATION_UNCERTAIN
        : result.status === 'FAILED'
          ? PublicationOutcome.PUBLISH_FAILED
          : result.status === 'DRY_RUN'
            ? PublicationOutcome.READY
            : result.status === 'CANCELLED'
              ? PublicationOutcome.CANCELLED
              : PublicationOutcome.PUBLISH_FAILED);

  const executionStatus =
    result.execution?.status ??
    (result.status === 'FAILED'
      ? AdapterExecutionStatus.FAILED
      : result.status === 'CANCELLED'
        ? AdapterExecutionStatus.ABORTED
        : AdapterExecutionStatus.COMPLETED);

  const operationId =
    result.operationId ?? result.requestId ?? context.operationId ?? null;
  const contentId =
    result.contentId ?? result.raw?.contentId ?? context.contentId ?? null;
  const accountId =
    result.accountId ??
    result.raw?.accountHandle ??
    result.publication?.evidence?.accountHandle ??
    null;

  const verified =
    result.publication?.verified === true ||
    (publicationOutcome === PublicationOutcome.PUBLICATION_CONFIRMED &&
      (simulated ||
        caps.name === 'instagram-graph' ||
        result.raw?.verification?.ok === true ||
        result.raw?.editor?.identity?.ok === true));

  const failureCode =
    result.failureCode ??
    result.publication?.failureCode ??
    (publicationOutcome === PublicationOutcome.PUBLICATION_UNCERTAIN
      ? 'PLATFORM_ERROR_UNCERTAIN'
      : publicationOutcome === PublicationOutcome.PUBLISH_FAILED
        ? failureCodeFromError({ message: result.message, code: result.raw?.error })
        : null);
  const failure = failureCode
    ? classifyPublicationFailure(failureCode, {
        outcome: publicationOutcome,
        shareMayHaveOccurred:
          publicationOutcome === PublicationOutcome.PUBLICATION_UNCERTAIN,
      })
    : null;

  return {
    contractVersion: PUBLICATION_ADAPTER_CONTRACT_VERSION,
    legacyStatus: result.status ?? null,
    operationId,
    accountId,
    contentId,
    execution: {
      status: executionStatus,
      state: result.execution?.state ?? result.raw?.machine?.state ?? null,
      shareIntentAt:
        result.execution?.shareIntentAt ??
        result.raw?.machine?.shareIntentAt ??
        null,
      shareInvokedAt:
        result.execution?.shareInvokedAt ??
        result.raw?.machine?.shareInvokedAt ??
        null,
    },
    publication: {
      outcome: publicationOutcome,
      verified,
      simulated,
      failureCode: failureCode ?? null,
      failure,
      evidence:
        result.publication?.evidence ??
        result.evidence ??
        result.raw?.verification ??
        null,
    },
    retryable:
      result.retryable ??
      result.publication?.retryable ??
      Boolean(failure?.retryable),
    evidence: result.evidence ?? result.publication?.evidence ?? result.raw ?? {},
    timestamps: result.timestamps ?? {
      shareIntentAt:
        result.execution?.shareIntentAt ??
        result.raw?.machine?.shareIntentAt ??
        null,
      shareInvokedAt:
        result.execution?.shareInvokedAt ??
        result.raw?.machine?.shareInvokedAt ??
        null,
      completedAt: result.completedAt ?? null,
    },
    diagnostics: result.diagnostics ?? {
      dir: result.raw?.diagnosticsDir ?? null,
    },
  };
}

/**
 * @param {ReturnType<typeof normalizeAdapterResult>} result
 */
export function assertPublicationAdapterContract(result) {
  if (!result || result.contractVersion !== PUBLICATION_ADAPTER_CONTRACT_VERSION) {
    throw new Error('Adapter result is missing the publication contract version.');
  }
  if (!result.operationId || typeof result.operationId !== 'string') {
    throw new Error('Adapter result is missing operationId.');
  }
  if (!result.contentId || typeof result.contentId !== 'string') {
    throw new Error('Adapter result is missing contentId.');
  }
  if (!Object.values(AdapterExecutionStatus).includes(result.execution?.status)) {
    throw new Error('Adapter result has an invalid execution status.');
  }
  if (!Object.values(PublicationOutcome).includes(result.publication?.outcome)) {
    throw new Error('Adapter result has an invalid publication outcome.');
  }
  if (
    result.publication.outcome === PublicationOutcome.PUBLICATION_CONFIRMED &&
    !result.publication.verified &&
    !result.publication.simulated
  ) {
    throw new Error(
      'Adapter claimed PUBLICATION_CONFIRMED without verified evidence or a simulated adapter.',
    );
  }
  return true;
}
