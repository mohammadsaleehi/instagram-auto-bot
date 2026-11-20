import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AuthState, detectAuthState } from '../../../auth/auth-state.js';
import {
  BROWSER_STORY_MEDIA_CONSTRAINTS,
  ContentError,
  ContentType,
} from '../constants.js';
import { STORY_UI } from './story-ui-selectors.js';
import { STORY_FAILURE_CODES, STORY_STATE_TIMEOUTS } from './story/story-states.js';
// Compatibility object: canonical states plus legacy aliases.
import { DEFAULT_STORY_TIMEOUTS, StoryPublishState } from './story-publish-states.js';
import { StoryPublishMachine } from './story/story-publish-machine.js';
import { StoryBrowserSession } from './story/story-browser-session.js';
import { StoryDiagnostics } from './story/story-diagnostics.js';
import { StoryEntry } from './story/story-entry.js';
import { StoryUpload } from './story/story-upload.js';
import { StoryEditor } from './story/story-editor.js';
import { validateShareAuthorization } from './story/story-share-authorization.js';
import { PublicationOutcome } from './publication-outcomes.js';
import { AdapterExecutionStatus } from './publication-adapter-contract.js';
import {
  observeAfterShare,
  readAccountHandle,
  verifyPublicationOnAccount,
} from './story/story-publication-verifier.js';

/**
 * @typedef {import('./publishing-adapter.js').PublishRequest} PublishRequest
 * @typedef {import('./publishing-adapter.js').PublishResult} PublishResult
 */

export class HumanInterventionRequiredError extends ContentError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown> }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      code: 'HUMAN_INTERVENTION_REQUIRED',
      details: options.details,
    });
    this.name = 'HumanInterventionRequiredError';
  }
}

class StoryStepError extends ContentError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message, { code, details });
    this.name = 'StoryStepError';
  }
}

/**
 * Browser-based Instagram Story publisher.
 *
 * The proven mobile-web portrait path:
 *   home (portrait) -> verified header Create (+) -> Story menu
 *   -> native filechooser -> upload -> real editor -> preview identity
 *   -> stable enabled "Add to your story" control.
 *
 * Publication is opt-in and remains off by default. A real attempt requires
 * `enablePublication: true`, a matching one-time authorization, a durable
 * operation store, and the expected authenticated account handle. The Share
 * intent is persisted before the single click; duplicate intents fail closed.
 */
export class PlaywrightStoryPublishingAdapter {
  /**
   * @param {{
   *   getPage: () => import('playwright').Page,
   *   baseUrl?: string,
   *   detectAuthStateFn?: typeof detectAuthState,
   *   navigationTimeoutMs?: number,
   *   uploadTimeoutMs?: number,
   *   idFn?: () => string,
   *   allowRealPublish?: boolean,
   *   enablePublication?: boolean,
   *   diagnosticsDir?: string | null,
   *   diagnosticsRetention?: number,
   *   mobileDeviceName?: string,
   *   identityMaxDistance?: number,
   *   operationStore?: import('./story/story-operation-store.js').StoryOperationStore | null,
   *   publicationAuthorization?: Record<string, unknown> | null,
   *   expectedAccountHandle?: string | null,
   *   publicationBaselineStoryIds?: string[],
   *   postShareTimeoutMs?: number,
   *   verificationTimeoutMs?: number,
   *   timeouts?: Partial<typeof DEFAULT_STORY_TIMEOUTS>,
   *   logger?: { info?: Function, warn?: Function, debug?: Function } | null,
   * }} options
   */
  constructor(options) {
    if (typeof options?.getPage !== 'function') {
      throw new ContentError('PlaywrightStoryPublishingAdapter requires getPage()', {
        code: STORY_FAILURE_CODES.BROWSER_PAGE_UNAVAILABLE,
      });
    }
    this.getPage = options.getPage;
    this.baseUrl = (options.baseUrl ?? 'https://www.instagram.com').replace(/\/$/, '');
    this._detectAuthState = options.detectAuthStateFn ?? detectAuthState;
    this.navigationTimeoutMs =
      options.navigationTimeoutMs ?? STORY_STATE_TIMEOUTS[StoryPublishState.NAVIGATING_HOME];
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? STORY_STATE_TIMEOUTS[StoryPublishState.FILE_SELECTED];
    this._id = options.idFn ?? (() => `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this.allowRealPublish = options.allowRealPublish !== false;
    /**
     * Phase 0–4 hard gate. Even if this option is true, the adapter stops at
     * the verified editor. Phase 5+ will consume it.
     */
    this.enablePublication = options.enablePublication === true && this.allowRealPublish;
    this.diagnosticsDir =
      options.diagnosticsDir === null
        ? null
        : options.diagnosticsDir ??
          path.resolve(process.cwd(), 'data/diagnostics/story-ui');
    this.diagnosticsRetention = options.diagnosticsRetention ?? 20;
    this.mobileDeviceName = options.mobileDeviceName ?? STORY_UI.mobileDeviceName;
    this.identityMaxDistance = options.identityMaxDistance;
    this.timeouts = { ...DEFAULT_STORY_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.operationStore = options.operationStore ?? null;
    this.publicationAuthorization = options.publicationAuthorization ?? null;
    this.expectedAccountHandle = options.expectedAccountHandle ?? null;
    this.publicationBaselineStoryIds = options.publicationBaselineStoryIds ?? [];
    this.postShareTimeoutMs = options.postShareTimeoutMs ?? this.timeouts.verifyingMs;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 90_000;
    this.logger = options.logger ?? null;
    this.phase = this.enablePublication ? 'publication' : 'entry-editor';
    /** @type {StoryPublishMachine|null} */
    this._machine = null;
    /** @type {StoryBrowserSession|null} */
    this._session = null;
  }

  getCapabilities() {
    return {
      name: 'playwright',
      isMock: false,
      /**
       * Publication is off unless the supervised constructor explicitly
       * enables it. PublishingService treats this as a hard gate.
       */
      dryRunOnly: !this.enablePublication,
      supportedContentTypes: [ContentType.STORY],
      constraints: BROWSER_STORY_MEDIA_CONSTRAINTS,
      requiredPermissions: ['authenticated-browser-session'],
      documentationUrl: 'local://playwright-story-publishing',
      surface: 'mobile-web-portrait',
      phase: this.phase,
      publicationEnabled: this.enablePublication,
    };
  }

  /**
   * Navigate first, then classify auth. A fresh storage-state page is
   * `about:blank`, so classifying before navigation returns UNKNOWN.
   *
   * @returns {Promise<{ok: boolean, message: string, details?: Record<string, unknown>}>}
   */
  async validateAccount() {
    const page = this._requirePage();
    const session = new StoryBrowserSession({
      page,
      deviceName: this.mobileDeviceName,
      timeouts: { stepPollMs: this.timeouts.stepPollMs },
      diagnostics: null,
      logger: this.logger,
    });
    try {
      await session.initialize();
      await this._navigateHome(page);
      await session.dismissBlockingDialogs();
      const orientation = await session.stabilizePortrait({ maxReloads: 2, label: 'validate' });
      const auth = await this._detectAuthState(page);
      if (auth.state === AuthState.AUTHENTICATED && orientation.ok) {
        return {
          ok: true,
          message: 'Browser session is authenticated and portrait-ready for Story publishing',
          details: { authState: auth.state, url: page.url(), orientation: orientation.environment },
        };
      }
      if (auth.state === AuthState.VERIFICATION_REQUIRED) {
        return {
          ok: false,
          message: 'Instagram verification / checkpoint detected. Complete it in the browser, then retry.',
          details: { authState: auth.state, url: page.url(), signals: auth.signals },
        };
      }
      return {
        ok: false,
        message: `Instagram session is not ready (state=${auth.state}, portrait=${orientation.ok}). Log in and retry.`,
        details: {
          authState: auth.state,
          url: page.url(),
          signals: auth.signals,
          orientation: orientation.environment,
          failureCode: orientation.failureCode,
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        details: { failureCode: error?.code ?? STORY_FAILURE_CODES.UNKNOWN },
      };
    }
  }

  /**
   * @param {PublishRequest} request
   * @returns {Promise<PublishResult>}
   */
  async publish(request) {
    const operationId = this._id();
    const machine = new StoryPublishMachine();
    this._machine = machine;
    this._session = null;
    /** @type {string[]} */
    const consoleErrors = [];
    /** @type {import('playwright').Page|null} */
    let page = null;
    const diagnostics = new StoryDiagnostics({
      rootDir: this.diagnosticsDir,
      operationId,
      logger: this.logger,
      retention: this.diagnosticsRetention,
    });
    /** @type {Record<string, unknown>|null} */
    let operation = null;
    /** @type {Record<string, unknown>|null} */
    let authorization = null;
    let realPublish = false;

    try {
      machine.transition('START');

      if (request.contentType !== ContentType.STORY) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.PREFLIGHT_CONTENT_TYPE_INVALID,
          `Playwright adapter publishes Stories only (got ${request.contentType})`,
          { contentType: request.contentType },
        );
      }
      const media = request.media?.[0];
      if (!media?.filePath || request.media.length !== 1) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID,
          'Story publish requires exactly one local media file',
          { mediaCount: request.media?.length ?? 0 },
        );
      }
      const stat = await fs.stat(media.filePath).catch(() => null);
      if (!stat?.isFile()) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID,
          `Story media file does not exist: ${media.filePath}`,
        );
      }
      const checksumSha256 = await this._hashFile(media.filePath);
      const mediaInfo = {
        fileName: path.basename(media.filePath),
        filePath: media.filePath,
        mimeType: media.mimeType,
        byteSize: stat.size,
        checksumSha256,
      };

      realPublish = request.dryRun !== true && this.enablePublication;
      if (realPublish) {
        if (!this.operationStore) {
          throw new StoryStepError(
            STORY_FAILURE_CODES.PUBLICATION_NOT_AUTHORIZED,
            'Real Story publication requires a durable operation store.',
          );
        }
        if (!this.expectedAccountHandle) {
          throw new StoryStepError(
            STORY_FAILURE_CODES.ACCOUNT_MISMATCH,
            'Real Story publication requires the expected authenticated account handle.',
          );
        }
        const check = validateShareAuthorization(this.publicationAuthorization, {
          operationId,
          contentId: request.contentId,
          mediaChecksumSha256: checksumSha256,
          now: new Date(),
        });
        if (!check.ok) {
          throw new StoryStepError(
            STORY_FAILURE_CODES.PUBLICATION_NOT_AUTHORIZED,
            `Real Story publication is not authorized for this operation (${check.reason}).`,
            { reason: check.reason },
          );
        }
        authorization = this.publicationAuthorization;
      }

      machine.transition('MEDIA_OK');

      if (realPublish) {
        try {
          operation = this.operationStore.create({
            operationId,
            contentId: request.contentId,
            attemptId: request.idempotencyKey,
            state: machine.state,
            mediaPath: media.filePath,
            mediaChecksumSha256: checksumSha256,
            idempotencyKey: request.idempotencyKey,
            diagnosticsDir: diagnostics.dir,
            evidence: {
              phase: 'preflight',
              authorization,
              media: mediaInfo,
            },
          });
        } catch (error) {
          throw new StoryStepError(
            STORY_FAILURE_CODES.SHARE_INTENT_NOT_PERSISTED,
            `Durable publication attempt could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      page = this._requirePage();
      this._attachPageDiagnostics(page, consoleErrors);
      const session = new StoryBrowserSession({
        page,
        deviceName: this.mobileDeviceName,
        timeouts: { stepPollMs: this.timeouts.stepPollMs },
        diagnostics,
        logger: this.logger,
      });
      this._session = session;

      // NAVIGATING_HOME — portrait metrics first, then load Instagram.
      await session.initialize();
      await this._navigateHome(page);
      await session.dismissBlockingDialogs();
      const stabilized = await session.stabilizePortrait({
        maxReloads: 2,
        label: 'home',
      });
      machine.transition('HOME_LOADED');
      if (!stabilized.ok) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT,
          `Instagram could not be kept in portrait orientation (${stabilized.environment?.screenOrientation ?? 'unknown'}).`,
          { environment: stabilized.environment, reloads: stabilized.reloads },
        );
      }
      if (await session.hasHumanBlockers()) {
        throw new HumanInterventionRequiredError(
          'Instagram security challenge or CAPTCHA detected. Complete it manually, then retry.',
          { details: { url: page.url() } },
        );
      }

      // AUTH_VERIFIED — classify only after navigation and stabilization.
      const auth = await this._detectAuthState(page);
      if (auth.state === AuthState.VERIFICATION_REQUIRED) {
        throw new HumanInterventionRequiredError(
          'Instagram verification / checkpoint detected. Complete it in the browser, then retry.',
          { details: { authState: auth.state, url: page.url(), signals: auth.signals } },
        );
      }
      if (auth.state !== AuthState.AUTHENTICATED) {
        machine.halt(
          StoryPublishState.AUTH_REQUIRED,
          STORY_FAILURE_CODES.AUTH_REQUIRED,
          `Instagram session is not ready (state=${auth.state}). Log in and retry.`,
        );
        await diagnostics.capture({
          page,
          cdp: session.cdp,
          stage: 'auth-required',
          extra: { auth },
          environment: await session.environment(),
        });
        return this._resultFromMachine(machine, request, operationId, diagnostics, consoleErrors, {
          auth,
        });
      }
      machine.transition('AUTH_OK');

      if (realPublish) {
        const actualHandle = await readAccountHandle(page);
        if (
          !actualHandle ||
          actualHandle.toLowerCase() !== this.expectedAccountHandle.toLowerCase()
        ) {
          throw new StoryStepError(
            STORY_FAILURE_CODES.ACCOUNT_MISMATCH,
            `Authenticated account is ${actualHandle ?? 'unknown'}, expected ${this.expectedAccountHandle}.`,
            { actualHandle, expectedAccountHandle: this.expectedAccountHandle },
          );
        }
        this.operationStore.updateState(operationId, machine.state, {
          evidence: { authState: auth.state, accountHandle: actualHandle },
        });
      }

      // SURFACE_READY — portrait invariant twice, no rotate overlay.
      const surface = await session.assertPortrait('surface-ready');
      if (!surface.ok) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT,
          `Portrait invariant failed before Story entry (${surface.environment?.screenOrientation ?? 'unknown'}).`,
          { environment: surface.environment },
        );
      }
      if (await session.hasRotateOverlay()) {
        throw new StoryStepError(
          STORY_FAILURE_CODES.ROTATE_OVERLAY_PRESENT,
          'Instagram shows the rotate-device warning before Story entry.',
          { environment: surface.environment },
        );
      }
      await session.capture('surface-ready', { authState: auth.state });

      // CREATE_MENU_OPEN -> STORY_OPTION_VERIFIED -> FILECHOOSER_ARMED ->
      // STORY_OPTION_CLICKED -> FILE_SELECTED. StoryEntry performs these steps
      // atomically; the machine records them in order after success.
      const entry = new StoryEntry({
        page,
        session,
        timeouts: { stepPollMs: this.timeouts.stepPollMs },
        logger: this.logger,
      });
      const entryResult = await entry.enter({ signal: request.signal });
      if (!entryResult.ok) {
        throw new StoryStepError(
          entryResult.failureCode ?? STORY_FAILURE_CODES.CREATE_MENU_NOT_OPENED,
          entryResult.message ?? 'Story entry failed.',
          {
            plus: entryResult.plus ?? null,
            menu: entryResult.menu ?? null,
            storyOption: entryResult.storyOption ?? null,
          },
        );
      }
      machine.transition('SURFACE_OK');
      machine.transition('MENU_READY');
      machine.transition('STORY_OPTION_OK');
      machine.transition('CHOOSER_ARMED');
      machine.transition('CHOOSER_RECEIVED');

      // FILE_SELECTED — upload and wait for the editor URL.
      const upload = new StoryUpload({
        page,
        session,
        timeouts: { stepPollMs: this.timeouts.stepPollMs },
        logger: this.logger,
      });
      const uploadResult = await upload.upload({
        chooser: entryResult.chooser,
        filePath: media.filePath,
        fileName: mediaInfo.fileName,
        signal: request.signal,
      });
      if (!uploadResult.ok) {
        throw new StoryStepError(
          uploadResult.failureCode ?? STORY_FAILURE_CODES.FILE_INPUT_REJECTED,
          uploadResult.message ?? 'Story upload failed.',
          { url: uploadResult.url ?? page.url(), via: uploadResult.via ?? null },
        );
      }
      machine.transition('FILE_ACCEPTED');

      // EDITOR_LOADING -> EDITOR_READY.
      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: this.timeouts.stepPollMs },
        identityMaxDistance: this.identityMaxDistance,
        logger: this.logger,
      });
      const editorResult = await editor.waitForReady({
        sourceFilePath: media.filePath,
        sourceMime: media.mimeType || 'image/jpeg',
        signal: request.signal,
        timeoutMs: this.uploadTimeoutMs,
      });
      if (!editorResult.ok) {
        throw new StoryStepError(
          editorResult.failureCode ?? STORY_FAILURE_CODES.EDITOR_NOT_OPENED,
          editorResult.message ?? 'Story editor did not become ready.',
          { evidence: editorResult.evidence ?? {} },
        );
      }
      machine.transition('EDITOR_DETECTED');
      await session.capture('editor-ready', editorResult.evidence ?? {});

      if (realPublish) {
        return await this._publishOnce({
          page,
          session,
          editor,
          machine,
          request,
          operationId,
          media,
          mediaInfo,
          checksumSha256,
          diagnostics,
          consoleErrors,
          authorization,
          editorEvidence: editorResult.evidence ?? {},
        });
      }

      // Dry-run gate: editor verified, Share is never clicked.
      machine.transition('EVIDENCE_CAPTURED');
      machine.transition('DRY_RUN_DONE');
      await this._dismissEditor(page);

      const finalized = await diagnostics.finalize({
        phase: this.phase,
        publicationEnabled: false,
        shareClicked: false,
        finalState: machine.state,
      });

      return this._dryRunResult({
        request,
        operationId,
        machine,
        mediaInfo,
        entry: {
          plus: entryResult.plus ?? null,
          menu: entryResult.menu ?? null,
          storyOption: entryResult.storyOption ?? null,
        },
        upload: uploadResult,
        editor: editorResult.evidence ?? {},
        consoleErrors,
        diagnostics: finalized,
      });
    } catch (error) {
      if (error instanceof HumanInterventionRequiredError) {
        const challenge =
          error.details?.authState === AuthState.VERIFICATION_REQUIRED ||
          error.details?.challenge === true;
        machine.halt(
          StoryPublishState.CHECKPOINT_REQUIRED,
          STORY_FAILURE_CODES.CHECKPOINT_REQUIRED,
          error.message,
        );
      } else if (error instanceof StoryStepError) {
        machine.fail(error.code, error.message);
      } else if (error?.name === 'AbortError' || request.signal?.aborted) {
        machine.abort('Story publish aborted');
      } else {
        machine.fail(
          STORY_FAILURE_CODES.UNKNOWN,
          error instanceof Error ? error.message : String(error),
        );
      }

      if (page && this._session?.cdp) {
        await diagnostics
          .capture({
            page,
            cdp: this._session.cdp,
            stage: `terminal-${machine.state}`,
            extra: {
              failureCode: machine.failureCode,
              failureMessage: machine.failureMessage,
              errorName: error?.name ?? null,
            },
            environment: await this._session.environment(),
          })
          .catch(() => null);
      }
      const finalized = await diagnostics.finalize({
        phase: this.phase,
        publicationEnabled: this.enablePublication,
        shareClicked: machine.shareWasInvoked,
        finalState: machine.state,
      });
      if (operation) {
        try {
          this.operationStore.finish({
            operationId,
            state: machine.state,
            failureCode: machine.failureCode,
            evidence: {
              error: error instanceof Error ? error.message : String(error),
              diagnostics: finalized,
              machine: machine.snapshot(),
            },
            shareClickResult: machine.shareWasInvoked ? 'dispatched-or-unknown' : null,
          });
        } catch {
          // The durable intent (if any) is already written; never retry here.
        }
      }
      return this._resultFromMachine(
        machine,
        request,
        operationId,
        diagnostics,
        consoleErrors,
        { error: error instanceof Error ? error.message : String(error), diagnostics: finalized },
      );
    } finally {
      if (page) this._detachPageDiagnostics(page);
    }
  }

  /**
   * @param {import('playwright').Page} page
   * @param {string[]} sink
   */
  _attachPageDiagnostics(page, sink) {
    this._onConsole = (message) => {
      if (message.type() === 'error') {
        sink.push(message.text().slice(0, 400));
      }
    };
    this._onPageError = (error) => {
      sink.push(`pageerror: ${error.message}`.slice(0, 400));
    };
    page.on('console', this._onConsole);
    page.on('pageerror', this._onPageError);
  }

  /**
   * @param {import('playwright').Page} page
   */
  _detachPageDiagnostics(page) {
    if (this._onConsole) page.off('console', this._onConsole);
    if (this._onPageError) page.off('pageerror', this._onPageError);
    this._onConsole = null;
    this._onPageError = null;
  }

  /**
   * @param {import('playwright').Page} page
   * @returns {Promise<void>}
   */
  async _navigateHome(page) {
    const homeUrl = `${this.baseUrl}/`;
    this._assertAllowedNavigation(homeUrl);
    await page.goto(homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });
    await page.waitForTimeout(500);
  }

  /**
   * @param {string} url
   */
  _assertAllowedNavigation(url) {
    if (/\/create\/story\/?/i.test(url) || /\/stories\/create\/?/i.test(url)) {
      throw new StoryStepError(
        'STORY_UI_DIRECT_URL_FORBIDDEN',
        'Direct Story URL navigation is forbidden; Story creation must use a UI click.',
        { url },
      );
    }
  }

  /**
   * Leave the editor without Share. Escape only; never clicks Share.
   * @param {import('playwright').Page} page
   */
  async _dismissEditor(page) {
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    } catch {
      // best effort
    }
  }

  /**
   * @returns {Promise<string>}
   */
  async _hashFile(filePath) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  /** @returns {import('playwright').Page} */
  _requirePage() {
    const page = this.getPage();
    if (!page) {
      throw new ContentError('Browser page is not available', {
        code: STORY_FAILURE_CODES.BROWSER_PAGE_UNAVAILABLE,
      });
    }
    return page;
  }

  /**
   * @param {{
   *   request: PublishRequest,
   *   operationId: string,
   *   machine: StoryPublishMachine,
   *   mediaInfo: Record<string, unknown>,
   *   entry: Record<string, unknown>,
   *   upload: Record<string, unknown>,
   *   editor: Record<string, unknown>,
   *   consoleErrors: string[],
   *   diagnostics: Record<string, unknown>|null,
   * }} input
   * @returns {PublishResult}
   */
  _dryRunResult(input) {
    return {
      status: 'DRY_RUN',
      simulated: true,
      externalPublishId: null,
      containerId: `dry_story_${input.request.contentId}`,
      requestId: input.operationId,
      operationId: input.operationId,
      accountId: this.expectedAccountHandle ?? null,
      contentId: input.request.contentId,
      execution: {
        status: AdapterExecutionStatus.COMPLETED,
        state: input.machine.state,
        shareIntentAt: null,
        shareInvokedAt: null,
      },
      publication: {
        outcome: PublicationOutcome.READY,
        verified: false,
        simulated: true,
        failureCode: null,
        evidence: {
          entry: input.entry,
          upload: input.upload,
          editor: input.editor,
          dryRun: true,
        },
      },
      failureCode: null,
      retryable: false,
      evidence: {
        entry: input.entry,
        upload: input.upload,
        editor: input.editor,
      },
      timestamps: {
        shareIntentAt: null,
        shareInvokedAt: null,
        completedAt: new Date().toISOString(),
      },
      diagnostics: input.diagnostics ?? { dir: null },
      message:
        'Story dry-run succeeded: mobile-web portrait entry, upload, preview identity, and enabled "Add to your story" control verified. Share was not clicked (Phases 0–4).',
      raw: {
        phase: this.phase,
        publicationEnabled: false,
        shareClicked: false,
        dryRun: true,
        surface: 'mobile-web-portrait',
        contentId: input.request.contentId,
        idempotencyKey: input.request.idempotencyKey,
        media: input.mediaInfo,
        entry: input.entry,
        upload: input.upload,
        editor: input.editor,
        consoleErrors: input.consoleErrors,
        diagnostics: input.diagnostics,
        machine: input.machine.snapshot(),
      },
    };
  }

  /**
   * The single real publication attempt. This method is only reached after
   * the editor, preview identity, account handle, one-time authorization,
   * and durable operation row have all been verified.
   *
   * @param {{
   *   page: import('playwright').Page,
   *   session: StoryBrowserSession,
   *   editor: StoryEditor,
   *   machine: StoryPublishMachine,
   *   request: PublishRequest,
   *   operationId: string,
   *   media: Record<string, any>,
   *   mediaInfo: Record<string, unknown>,
   *   checksumSha256: string,
   *   diagnostics: StoryDiagnostics,
   *   consoleErrors: string[],
   *   authorization: Record<string, unknown>,
   *   editorEvidence: Record<string, unknown>,
   * }} input
   * @returns {Promise<PublishResult>}
   */
  async _publishOnce(input) {
    const {
      page,
      session,
      editor,
      machine,
      request,
      operationId,
      media,
      mediaInfo,
      checksumSha256,
      diagnostics,
      consoleErrors,
      authorization,
      editorEvidence,
    } = input;
    const store = this.operationStore;
    if (!store) {
      throw new StoryStepError(
        STORY_FAILURE_CODES.PUBLICATION_NOT_AUTHORIZED,
        'Durable operation store is required for a real Story publication.',
      );
    }

    machine.transition('EVIDENCE_CAPTURED');
    store.updateState(operationId, machine.state, {
      evidence: { editor: editorEvidence, authorization },
    });
    await session.capture('pre-share-snapshot', {
      editor: editorEvidence,
      accountHandle: this.expectedAccountHandle,
      authorization,
    });

    // Final pre-Share proof: the exact enabled control must still belong to
    // the real Story editor, in portrait, with no rotate warning/challenge.
    const preShare = await editor.quickCheck();
    if (!preShare.ok) {
      throw new StoryStepError(
        preShare.failureCode ?? STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND,
        preShare.message ?? 'Story editor failed the final pre-Share check.',
        { evidence: preShare.evidence ?? {} },
      );
    }
    if (!/\/create\/story\/?/i.test(page.url())) {
      throw new StoryStepError(
        STORY_FAILURE_CODES.EDITOR_URL_INVALID,
        `Pre-Share URL is not the Story editor (got ${page.url()}).`,
      );
    }
    const orientation = await session.assertPortrait('pre-share');
    if (!orientation.ok) {
      throw new StoryStepError(
        STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT,
        `Pre-Share orientation is ${orientation.environment?.screenOrientation ?? 'unknown'}.`,
        { environment: orientation.environment },
      );
    }
    if (await session.hasRotateOverlay()) {
      throw new StoryStepError(
        STORY_FAILURE_CODES.ROTATE_OVERLAY_PRESENT,
        'Rotate-device warning is visible before Share.',
      );
    }
    if (await session.hasHumanBlockers()) {
      throw new HumanInterventionRequiredError(
        'Instagram challenge appeared before Share.',
      );
    }

    // Durable one-time intent BEFORE the click. This transaction is the
    // crash-safety boundary: once it commits, the operation is never retried.
    try {
      store.recordShareIntent({
        operationId,
        contentId: request.contentId,
        mediaChecksumSha256: checksumSha256,
        idempotencyKey: request.idempotencyKey,
        fromState: machine.state,
        evidence: {
          authorization,
          preShare: preShare.evidence ?? {},
          media: mediaInfo,
        },
      });
    } catch (error) {
      throw new StoryStepError(
        // @ts-expect-error - structured code on a plain Error
        error?.code ?? STORY_FAILURE_CODES.SHARE_INTENT_NOT_PERSISTED,
        error instanceof Error ? error.message : String(error),
        // @ts-expect-error - structured details on a plain Error
        error?.details ?? {},
      );
    }

    machine.recordShareIntent(operationId);
    machine.transition('SHARE_INTENT_PERSISTED');

    const click = await editor.clickShareOnce({ signal: request.signal });
    if (!click.ok) {
      if (click.dispatched === true || click.dispatched === 'unknown') {
        // The click may have reached Instagram. Never retry.
        machine.recordShareInvoked();
      }
      throw new StoryStepError(
        click.failureCode ?? STORY_FAILURE_CODES.SHARE_CLICK_AMBIGUOUS,
        click.message ?? 'Share click did not complete.',
        { click },
      );
    }

    machine.recordShareInvoked();
    machine.transition('SHARE_CLICKED');
    store.recordShareClicked(operationId, 'dispatched');
    machine.transition('OBSERVE');
    store.updateState(operationId, machine.state, { evidence: { click } });

    const observed = await observeAfterShare(page, { timeoutMs: this.postShareTimeoutMs });
    await session.capture('post-share-observation', { observed });

    const verification = await verifyPublicationOnAccount({
      page,
      cdp: session.cdp,
      handle: this.expectedAccountHandle,
      sourceFilePath: media.filePath,
      sourceMime: media.mimeType || 'image/jpeg',
      timeoutMs: this.verificationTimeoutMs,
      baselineStoryIds: this.publicationBaselineStoryIds,
      maxIdentityDistance: 32,
      onViewer: async ({ viewer }) => {
        await session.capture('post-share-viewer', {
          storyId: viewer.storyId,
          timeLabels: viewer.timeLabels,
          media: viewer.media
            ? {
                tag: viewer.media.tag,
                naturalWidth: viewer.media.naturalWidth,
                naturalHeight: viewer.media.naturalHeight,
                srcHost: viewer.media.srcHost,
              }
            : null,
        });
      },
    });
    await session.capture('post-share-verification', { verification });

    if (!verification.ok) {
      machine.transition('SHARE_UNCERTAIN');
      store.finish({
        operationId,
        state: machine.state,
        failureCode: machine.failureCode ?? STORY_FAILURE_CODES.SHARE_NOT_CONFIRMED,
        evidence: {
          authorization,
          accountHandle: this.expectedAccountHandle,
          media: mediaInfo,
          observed,
          verification,
        },
        shareClickResult: 'dispatched',
      });
      const finalized = await diagnostics.finalize({
        phase: this.phase,
        publicationEnabled: true,
        shareClicked: true,
        finalState: machine.state,
      });
      return this._resultFromMachine(machine, request, operationId, diagnostics, consoleErrors, {
        observed,
        verification,
        diagnostics: finalized,
      });
    }

    machine.transition('SHARE_CONFIRMED');
    store.finish({
      operationId,
      state: machine.state,
      failureCode: null,
      evidence: {
        authorization,
        accountHandle: this.expectedAccountHandle,
        media: mediaInfo,
        observed,
        verification,
      },
      shareClickResult: 'dispatched',
    });
    const finalized = await diagnostics.finalize({
      phase: this.phase,
      publicationEnabled: true,
      shareClicked: true,
      finalState: machine.state,
    });
    return this._resultFromMachine(machine, request, operationId, diagnostics, consoleErrors, {
      observed,
      verification,
      externalPublishId: verification.storyId ?? null,
      containerId: verification.storyId ?? null,
      diagnostics: finalized,
    });
  }

  /**
   * @param {StoryPublishMachine} machine
   * @param {PublishRequest} request
   * @param {string} operationId
   * @param {StoryDiagnostics} diagnostics
   * @param {string[]} consoleErrors
   * @param {Record<string, unknown>} extra
   * @returns {PublishResult}
   */
  _resultFromMachine(machine, request, operationId, diagnostics, consoleErrors, extra) {
    const outcome = machine.outcome() ?? 'FAILED';
    const externalPublishId = extra.externalPublishId ?? null;
    const containerId =
      extra.containerId ??
      (outcome === 'DRY_RUN' ? `dry_story_${request.contentId}` : null);
    const canonicalOutcome =
      outcome === 'SUCCEEDED'
        ? PublicationOutcome.PUBLICATION_CONFIRMED
        : outcome === 'UNCERTAIN'
          ? PublicationOutcome.PUBLICATION_UNCERTAIN
          : outcome === 'DRY_RUN'
            ? PublicationOutcome.READY
            : PublicationOutcome.PUBLISH_FAILED;
    const executionStatus =
      outcome === 'FAILED'
        ? AdapterExecutionStatus.FAILED
        : AdapterExecutionStatus.COMPLETED;
    const verified =
      canonicalOutcome === PublicationOutcome.PUBLICATION_CONFIRMED &&
      extra.verification?.ok === true;
    const raw = {
      phase: this.phase,
      publicationEnabled: this.enablePublication,
      shareClicked: machine.shareWasInvoked,
      dryRun: outcome === 'DRY_RUN',
      surface: 'mobile-web-portrait',
      contentId: request.contentId,
      idempotencyKey: request.idempotencyKey,
      consoleErrors,
      diagnosticsDir: diagnostics.dir,
      ...extra,
      externalPublishId,
      containerId,
      machine: machine.snapshot(),
    };
    return {
      status: /** @type {'SUCCEEDED'|'UNCERTAIN'|'FAILED'|'DRY_RUN'} */ (outcome),
      simulated: outcome === 'DRY_RUN',
      externalPublishId,
      containerId,
      requestId: operationId,
      operationId,
      accountId: this.expectedAccountHandle ?? null,
      contentId: request.contentId,
      execution: {
        status: executionStatus,
        state: machine.state,
        shareIntentAt: machine.shareIntentAt,
        shareInvokedAt: machine.shareInvokedAt,
      },
      publication: {
        outcome: canonicalOutcome,
        verified,
        simulated: outcome === 'DRY_RUN',
        failureCode: machine.failureCode ?? null,
        evidence: extra.verification ?? extra.observed ?? null,
      },
      failureCode: machine.failureCode ?? null,
      retryable: machine.isRetryable(),
      evidence: extra.verification ?? extra.observed ?? {},
      timestamps: {
        shareIntentAt: machine.shareIntentAt,
        shareInvokedAt: machine.shareInvokedAt,
        completedAt: new Date().toISOString(),
      },
      diagnostics: extra.diagnostics ?? { dir: diagnostics.dir },
      message:
        outcome === 'DRY_RUN'
          ? 'Dry-run complete; Share was not clicked.'
          : outcome === 'SUCCEEDED'
            ? 'Story publication confirmed on the account.'
            : machine.failureMessage ??
              (outcome === 'UNCERTAIN'
                ? 'Story publication outcome is uncertain; do not retry blindly.'
                : 'Story publish failed before Share.'),
      raw,
    };
  }
}

export { StoryPublishState, DEFAULT_STORY_TIMEOUTS };
