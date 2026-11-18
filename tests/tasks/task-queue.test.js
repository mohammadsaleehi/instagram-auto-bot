import { describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { EventRepository } from '../../src/storage/repositories/event-repository.js';
import { TaskQueue } from '../../src/tasks/task-queue.js';
import { TaskStatus } from '../../src/tasks/constants.js';

function createQueue() {
  const database = new Database({ filePath: ':memory:' });
  database.open();
  const tasks = new TaskRepository(database);
  const events = new EventRepository(database);
  const queue = new TaskQueue({ tasks, events });
  return { database, tasks, events, queue };
}

describe('TaskQueue', () => {
  it('creates tasks and retrieves them persistently', () => {
    const { queue, tasks } = createQueue();
    const { task, created } = queue.enqueue({
      type: 'engine.health-check',
      payload: { a: 1 },
      priority: 50,
    });
    expect(created).toBe(true);
    expect(tasks.getById(task.id)?.payload).toEqual({ a: 1 });
  });

  it('respects priority order when claiming', () => {
    const { queue } = createQueue();
    queue.enqueue({ type: 'engine.health-check', priority: 10, payload: { id: 'low' } });
    queue.enqueue({ type: 'engine.health-check', priority: 200, payload: { id: 'high' } });

    const first = queue.claimNext({ workerId: 'w1' });
    expect(first?.payload.id).toBe('high');
    expect(first?.status).toBe(TaskStatus.RUNNING);
  });

  it('prevents duplicate idempotency keys', () => {
    const { queue } = createQueue();
    const first = queue.enqueue({
      type: 'engine.health-check',
      idempotencyKey: 'same',
      payload: { n: 1 },
    });
    const second = queue.enqueue({
      type: 'engine.health-check',
      idempotencyKey: 'same',
      payload: { n: 2 },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('prevents two workers from claiming the same task', () => {
    const { queue } = createQueue();
    queue.enqueue({ type: 'engine.health-check', payload: {} });
    const a = queue.claimNext({ workerId: 'a' });
    const b = queue.claimNext({ workerId: 'b' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('cancels pending tasks safely', () => {
    const { queue } = createQueue();
    const { task } = queue.enqueue({ type: 'engine.health-check' });
    const cancelled = queue.cancel(task.id, { reason: 'test' });
    expect(cancelled?.status).toBe(TaskStatus.CANCELLED);
  });
});
