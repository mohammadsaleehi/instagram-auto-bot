import { describe, expect, it } from 'vitest';
import {
  AdapterExecutionStatus,
  PUBLICATION_ADAPTER_CONTRACT_VERSION,
  assertPublicationAdapterContract,
  normalizeAdapterResult,
} from '../../src/modules/content/publishing/publication-adapter-contract.js';
import { PublicationOutcome } from '../../src/modules/content/publishing/publication-outcomes.js';
import {
  classifyPublicationFailure,
  failureCodeFromError,
} from '../../src/modules/content/publishing/publication-failure-classification.js';

describe('publication adapter contract', () => {
  it('normalizes a verified Playwright result and enforces the contract', () => {
    const normalized = normalizeAdapterResult(
      {
        status: 'SUCCEEDED',
        requestId: 'op-1',
        operationId: 'op-1',
        accountId: 'test_account',
        contentId: 'content-1',
        simulated: false,
        execution: {
          status: AdapterExecutionStatus.COMPLETED,
          shareIntentAt: '2026-11-19T15:48:37.377Z',
          shareInvokedAt: '2026-11-19T15:48:37.699Z',
        },
        publication: {
          outcome: PublicationOutcome.PUBLICATION_CONFIRMED,
          verified: true,
          evidence: { identity: { ok: true, distance: 5.23 } },
        },
        raw: { verification: { ok: true } },
      },
      { caps: { name: 'playwright', isMock: false }, contentId: 'content-1' },
    );
    expect(normalized.contractVersion).toBe(PUBLICATION_ADAPTER_CONTRACT_VERSION);
    expect(normalized.operationId).toBe('op-1');
    expect(normalized.accountId).toBe('test_account');
    expect(normalized.contentId).toBe('content-1');
    expect(normalized.execution.status).toBe(AdapterExecutionStatus.COMPLETED);
    expect(normalized.publication.outcome).toBe(
      PublicationOutcome.PUBLICATION_CONFIRMED,
    );
    expect(normalized.publication.verified).toBe(true);
    expect(assertPublicationAdapterContract(normalized)).toBe(true);
  });

  it('keeps execution success separate from publication uncertainty', () => {
    const normalized = normalizeAdapterResult({
      status: 'UNCERTAIN',
      requestId: 'op-2',
      contentId: 'content-1',
      execution: { status: AdapterExecutionStatus.COMPLETED },
      publication: {
        outcome: PublicationOutcome.PUBLICATION_UNCERTAIN,
        verified: false,
      },
    });
    expect(normalized.execution.status).toBe(AdapterExecutionStatus.COMPLETED);
    expect(normalized.publication.outcome).toBe(
      PublicationOutcome.PUBLICATION_UNCERTAIN,
    );
    expect(normalized.publication.outcome).not.toBe(
      PublicationOutcome.PUBLICATION_CONFIRMED,
    );
    expect(assertPublicationAdapterContract(normalized)).toBe(true);
  });

  it('rejects a claimed confirmation without verified evidence or simulation', () => {
    const normalized = normalizeAdapterResult({
      status: 'SUCCEEDED',
      requestId: 'op-3',
      contentId: 'content-1',
      simulated: false,
      execution: { status: AdapterExecutionStatus.COMPLETED },
      publication: {
        outcome: PublicationOutcome.PUBLICATION_CONFIRMED,
        verified: false,
      },
    });
    expect(() => assertPublicationAdapterContract(normalized)).toThrow(
      /without verified evidence/i,
    );
  });

  it('normalizes legacy mock and Graph results', () => {
    const mock = normalizeAdapterResult(
      { status: 'SUCCEEDED', simulated: true, requestId: 'mock-1' },
      { caps: { name: 'mock', isMock: true }, contentId: 'content-1' },
    );
    expect(mock.publication.outcome).toBe(
      PublicationOutcome.PUBLICATION_CONFIRMED,
    );
    expect(mock.publication.simulated).toBe(true);
    expect(assertPublicationAdapterContract(mock)).toBe(true);

    const graph = normalizeAdapterResult(
      { status: 'SUCCEEDED', requestId: 'graph-1', raw: { platformAccepted: true } },
      { caps: { name: 'instagram-graph', isMock: false }, contentId: 'content-1' },
    );
    expect(graph.publication.outcome).toBe(
      PublicationOutcome.PUBLICATION_CONFIRMED,
    );
    expect(graph.publication.verified).toBe(true);
    expect(assertPublicationAdapterContract(graph)).toBe(true);
  });

  it('requires operation and content identity in the contract', () => {
    const normalized = normalizeAdapterResult({ status: 'SUCCEEDED' });
    expect(() => assertPublicationAdapterContract(normalized)).toThrow(
      /operationId/,
    );
  });
});

describe('publication failure classification', () => {
  it('classifies pre-Share failures as safe failures', () => {
    for (const code of [
      'MEDIA_MISSING',
      'PREVIEW_MISMATCH',
      'SHARE_DISABLED',
      'EDITOR_UNAVAILABLE',
    ]) {
      const failure = classifyPublicationFailure(code);
      expect(failure.outcome).toBe(PublicationOutcome.PUBLISH_FAILED);
      expect(failure.shareMayHaveOccurred).toBe(false);
    }
  });

  it('classifies post-Share ambiguity as uncertain and non-retryable', () => {
    for (const code of [
      'SHARE_DISPATCHED_NO_RESPONSE',
      'BROWSER_CRASH_AFTER_SHARE',
      'NETWORK_DISCONNECT_AFTER_SHARE',
      'SUCCESS_TOAST_MISSING',
      'TOAST_VISIBLE_VIEWER_UNAVAILABLE',
      'VIEWER_IMAGE_MISMATCH',
      'ACCOUNT_MISMATCH',
      'DUPLICATE_STORY',
      'PLATFORM_ERROR_UNCERTAIN',
    ]) {
      const failure = classifyPublicationFailure(code);
      expect(failure.outcome).toBe(PublicationOutcome.PUBLICATION_UNCERTAIN);
      expect(failure.shareMayHaveOccurred).toBe(true);
      expect(failure.retryable).toBe(false);
      expect(failure.manualIntervention).toBe(true);
    }
  });

  it('maps errors to stable failure codes conservatively', () => {
    expect(failureCodeFromError(new Error('captcha required'))).toBe(
      'CHECKPOINT_REQUIRED',
    );
    expect(failureCodeFromError(new Error('login required'))).toBe(
      'AUTHENTICATION_REQUIRED',
    );
    expect(failureCodeFromError(new Error('CDP session lost'))).toBe(
      'CDP_CONNECTION_FAILED',
    );
    const unknownWithShare = classifyPublicationFailure('UNKNOWN', {
      shareMayHaveOccurred: true,
    });
    expect(unknownWithShare.outcome).toBe(PublicationOutcome.PUBLICATION_UNCERTAIN);
    expect(unknownWithShare.retryable).toBe(false);
  });
});
