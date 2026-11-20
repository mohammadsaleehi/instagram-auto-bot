import { describe, expect, it } from 'vitest';
import {
  StoryPublishMachine,
  classifyStoryOutcome,
  normalizeStoryState,
} from '../../../src/modules/content/publishing/story/story-publish-machine.js';
import {
  STORY_FAILURE_CODES,
  StoryPublishState,
} from '../../../src/modules/content/publishing/story/story-states.js';

function advanceTo(machine, target) {
  /** @type {Record<string, string[]>} */
  const path = {
    [StoryPublishState.PREFLIGHT]: ['START'],
    [StoryPublishState.NAVIGATING_HOME]: ['START', 'MEDIA_OK'],
    [StoryPublishState.AUTH_VERIFIED]: ['START', 'MEDIA_OK', 'HOME_LOADED'],
    [StoryPublishState.SURFACE_READY]: ['START', 'MEDIA_OK', 'HOME_LOADED', 'AUTH_OK'],
    [StoryPublishState.CREATE_MENU_OPEN]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
    ],
    [StoryPublishState.STORY_OPTION_VERIFIED]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
    ],
    [StoryPublishState.FILECHOOSER_ARMED]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
    ],
    [StoryPublishState.STORY_OPTION_CLICKED]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
      'CHOOSER_ARMED',
    ],
    [StoryPublishState.FILE_SELECTED]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
      'CHOOSER_ARMED',
      'CHOOSER_RECEIVED',
    ],
    [StoryPublishState.EDITOR_LOADING]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
      'CHOOSER_ARMED',
      'CHOOSER_RECEIVED',
      'FILE_ACCEPTED',
    ],
    [StoryPublishState.EDITOR_READY]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
      'CHOOSER_ARMED',
      'CHOOSER_RECEIVED',
      'FILE_ACCEPTED',
      'EDITOR_DETECTED',
    ],
    [StoryPublishState.PRE_SHARE_SNAPSHOT]: [
      'START',
      'MEDIA_OK',
      'HOME_LOADED',
      'AUTH_OK',
      'SURFACE_OK',
      'MENU_READY',
      'STORY_OPTION_OK',
      'CHOOSER_ARMED',
      'CHOOSER_RECEIVED',
      'FILE_ACCEPTED',
      'EDITOR_DETECTED',
      'EVIDENCE_CAPTURED',
    ],
  };
  for (const event of path[target] ?? []) machine.transition(event);
  return machine;
}

describe('StoryPublishMachine', () => {
  it('starts in INITIALIZING and requires START', () => {
    const machine = new StoryPublishMachine();
    expect(machine.state).toBe(StoryPublishState.INITIALIZING);
    expect(machine.can('MEDIA_OK')).toBe(false);
    expect(() => machine.transition('MEDIA_OK')).toThrow(/Illegal Story transition/);
    machine.transition('START');
    expect(machine.state).toBe(StoryPublishState.PREFLIGHT);
  });

  it('walks the happy path to EDITOR_READY', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.EDITOR_READY);
    expect(machine.state).toBe(StoryPublishState.EDITOR_READY);
    expect(machine.outcome()).toBeNull();
    expect(machine.isTerminal).toBe(false);
  });

  it('classifies a pre-share failure as PUBLISH_FAILED and retryable', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.EDITOR_LOADING);
    const state = machine.fail(
      STORY_FAILURE_CODES.EDITOR_NOT_OPENED,
      'editor missing',
    );
    expect(state).toBe(StoryPublishState.PUBLISH_FAILED);
    expect(machine.outcome()).toBe('FAILED');
    expect(machine.isRetryable()).toBe(true);
    expect(machine.failureCode).toBe(STORY_FAILURE_CODES.EDITOR_NOT_OPENED);
  });

  it('classifies failure after share intent as PUBLICATION_UNCERTAIN', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.PRE_SHARE_SNAPSHOT);
    machine.recordShareIntent('op-1');
    const state = machine.fail(STORY_FAILURE_CODES.SHARE_NOT_CONFIRMED, 'no evidence');
    expect(state).toBe(StoryPublishState.PUBLICATION_UNCERTAIN);
    expect(machine.outcome()).toBe('UNCERTAIN');
    expect(machine.isRetryable()).toBe(false);
  });

  it('classifies failure after share invocation as PUBLICATION_UNCERTAIN', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.PRE_SHARE_SNAPSHOT);
    machine.transition('SHARE_INTENT_PERSISTED');
    machine.transition('SHARE_CLICKED');
    machine.recordShareIntent('op-2');
    machine.recordShareInvoked();
    const state = machine.fail(STORY_FAILURE_CODES.SHARE_NOT_CONFIRMED, 'timeout');
    expect(state).toBe(StoryPublishState.PUBLICATION_UNCERTAIN);
    expect(machine.outcome()).toBe('UNCERTAIN');
  });

  it('keeps pre-share abort as a safe failure and post-share abort as uncertain', () => {
    const before = advanceTo(new StoryPublishMachine(), StoryPublishState.EDITOR_LOADING);
    expect(before.abort('operator stop')).toBe(StoryPublishState.ABORTED);
    expect(before.outcome()).toBe('FAILED');
    expect(before.isRetryable()).toBe(true);

    const after = advanceTo(new StoryPublishMachine(), StoryPublishState.PRE_SHARE_SNAPSHOT);
    after.recordShareIntent('op-3');
    expect(after.abort('operator stop')).toBe(StoryPublishState.PUBLICATION_UNCERTAIN);
    expect(after.outcome()).toBe('UNCERTAIN');
    expect(after.isRetryable()).toBe(false);
  });

  it('halts on AUTH_REQUIRED / CHECKPOINT_REQUIRED without pretending it is retryable uncertainty', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.AUTH_VERIFIED);
    expect(
      machine.halt(
        StoryPublishState.AUTH_REQUIRED,
        STORY_FAILURE_CODES.AUTH_REQUIRED,
        'login',
      ),
    ).toBe(StoryPublishState.AUTH_REQUIRED);
    expect(machine.outcome()).toBe('FAILED');
    expect(machine.shareIntentRecorded).toBe(false);

    const challenge = advanceTo(new StoryPublishMachine(), StoryPublishState.AUTH_VERIFIED);
    expect(
      challenge.halt(
        StoryPublishState.CHECKPOINT_REQUIRED,
        STORY_FAILURE_CODES.CHECKPOINT_REQUIRED,
        'captcha',
      ),
    ).toBe(StoryPublishState.CHECKPOINT_REQUIRED);
    expect(challenge.outcome()).toBe('FAILED');
  });

  it('reaches DRY_RUN_COMPLETE without any share intent', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.EDITOR_READY);
    machine.transition('EVIDENCE_CAPTURED');
    machine.transition('DRY_RUN_DONE');
    expect(machine.state).toBe(StoryPublishState.DRY_RUN_COMPLETE);
    expect(machine.outcome()).toBe('DRY_RUN');
    expect(machine.shareIntentRecorded).toBe(false);
    expect(machine.shareWasInvoked).toBe(false);
  });

  it('refuses duplicate share intent and share invocation before intent', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.PRE_SHARE_SNAPSHOT);
    expect(() => machine.recordShareInvoked()).toThrow(/before intent/);
    machine.recordShareIntent('op-4');
    expect(() => machine.recordShareIntent('op-4')).toThrow(/already recorded/);
    machine.recordShareInvoked();
    expect(() => machine.recordShareInvoked()).toThrow(/already invoked/);
  });

  it('classifies PUBLICATION_CONFIRMED as SUCCEEDED only', () => {
    const machine = advanceTo(new StoryPublishMachine(), StoryPublishState.PRE_SHARE_SNAPSHOT);
    machine.transition('SHARE_INTENT_PERSISTED');
    machine.transition('SHARE_CLICKED');
    machine.transition('OBSERVE');
    machine.transition('SHARE_CONFIRMED');
    expect(machine.state).toBe(StoryPublishState.PUBLICATION_CONFIRMED);
    expect(machine.outcome()).toBe('SUCCEEDED');
  });

  it('normalizes legacy state names', () => {
    expect(normalizeStoryState('READY_TO_SHARE')).toBe(StoryPublishState.EDITOR_READY);
    expect(normalizeStoryState('SHARE_FAILED')).toBe(StoryPublishState.PUBLISH_FAILED);
    expect(normalizeStoryState('PUBLISHED')).toBe(StoryPublishState.PUBLICATION_CONFIRMED);
  });

  it('exposes classification for every terminal state', () => {
    expect(classifyStoryOutcome(StoryPublishState.PUBLISH_FAILED)).toBe('FAILED');
    expect(classifyStoryOutcome(StoryPublishState.PUBLICATION_UNCERTAIN)).toBe('UNCERTAIN');
    expect(classifyStoryOutcome(StoryPublishState.PUBLICATION_CONFIRMED)).toBe('SUCCEEDED');
    expect(classifyStoryOutcome(StoryPublishState.DRY_RUN_COMPLETE)).toBe('DRY_RUN');
    expect(classifyStoryOutcome(StoryPublishState.EDITOR_READY)).toBeNull();
  });
});
