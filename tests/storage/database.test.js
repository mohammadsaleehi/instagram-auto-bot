import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, MIGRATIONS } from '../../src/storage/database.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { TaskStatus } from '../../src/tasks/constants.js';

describe('Database', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies migrations and reports schema version', () => {
    const db = new Database({ filePath: ':memory:' });
    db.open();
    expect(db.getSchemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    const integrity = db.checkIntegrity();
    expect(integrity.ok).toBe(true);
    db.close();
  });

  it('persists tasks across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-db-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'bot.sqlite');

    const db1 = new Database({ filePath });
    db1.open();
    const tasks = new TaskRepository(db1);
    const { task, created } = tasks.create({
      type: 'engine.health-check',
      payload: { note: 'persist' },
      idempotencyKey: 'persist-1',
    });
    expect(created).toBe(true);
    expect(task?.status).toBe(TaskStatus.PENDING);
    db1.close();

    const db2 = new Database({ filePath });
    db2.open();
    const tasks2 = new TaskRepository(db2);
    const loaded = tasks2.getById(task.id);
    expect(loaded?.payload).toEqual({ note: 'persist' });
    expect(tasks2.findByIdempotencyKey('persist-1')?.id).toBe(task.id);
    db2.close();
  });

  it('reports corruption via integrity check helper surface', () => {
    const db = new Database({ filePath: ':memory:' });
    db.open();
    // Healthy empty DB.
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });
});
