import { describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { EventRepository } from '../../src/storage/repositories/event-repository.js';
import { ScheduleRepository } from '../../src/storage/repositories/schedule-repository.js';
import { TaskQueue } from '../../src/tasks/task-queue.js';
import { ScheduleStore } from '../../src/scheduler/schedule-store.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('Scheduler', () => {
  it('enqueues one-time schedules and disables them', () => {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    const tasks = new TaskRepository(database);
    const events = new EventRepository(database);
    const queue = new TaskQueue({ tasks, events });
    const store = new ScheduleStore(new ScheduleRepository(database));
    const scheduler = new Scheduler({
      store,
      enqueue: (input) => queue.enqueue(input),
      logger: createLogger(),
      timezone: 'Europe/Berlin',
    });

    const runAt = new Date(Date.now() - 1_000).toISOString();
    scheduler.schedule({
      id: 'once-1',
      taskType: 'engine.health-check',
      payload: { note: 'scheduled' },
      runAt,
      idempotencyPrefix: 'once-1',
    });

    const { enqueued } = scheduler.tick(new Date());
    expect(enqueued).toBe(1);
    expect(queue.size()).toBe(1);

    // Second tick must not duplicate.
    const again = scheduler.tick(new Date());
    expect(again.enqueued).toBe(0);
    expect(store.get('once-1')?.enabled).toBe(false);
  });

  it('skips missed interval backlog and advances cursor', () => {
    const database = new Database({ filePath: ':memory:' });
    database.open();
    const tasks = new TaskRepository(database);
    const events = new EventRepository(database);
    const queue = new TaskQueue({ tasks, events });
    const store = new ScheduleStore(new ScheduleRepository(database));
    const now = new Date('2026-01-01T12:00:00.000Z');
    const scheduler = new Scheduler({
      store,
      enqueue: (input) => queue.enqueue(input),
      logger: createLogger(),
      nowFn: () => now,
    });

    scheduler.schedule({
      id: 'interval-1',
      taskType: 'engine.health-check',
      intervalMs: 60_000,
      runAt: new Date('2026-01-01T11:00:00.000Z'),
      catchUpPolicy: 'skip_missed',
      maxCatchUp: 1,
      idempotencyPrefix: 'interval-1',
    });

    const { enqueued } = scheduler.tick(now);
    expect(enqueued).toBe(1);
    // Only one task despite many missed slots.
    expect(queue.list().length).toBe(1);
    const next = store.get('interval-1')?.nextRunAt;
    expect(new Date(next).getTime()).toBeGreaterThan(now.getTime());
  });
});
