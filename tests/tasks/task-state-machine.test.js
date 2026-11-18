import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
} from '../../src/tasks/task-state-machine.js';
import { TaskStatus } from '../../src/tasks/constants.js';

describe('task state machine', () => {
  it('allows PENDING -> RUNNING and RUNNING -> COMPLETED', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.RUNNING)).toBe(true);
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.COMPLETED)).toBe(true);
  });

  it('rejects COMPLETED -> PENDING', () => {
    expect(canTransition(TaskStatus.COMPLETED, TaskStatus.PENDING)).toBe(false);
    expect(() =>
      assertTransition(TaskStatus.COMPLETED, TaskStatus.PENDING),
    ).toThrow(/Invalid task transition/);
  });
});
