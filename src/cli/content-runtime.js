import { loadConfig } from '../config/config.js';
import { Database } from '../storage/database.js';
import { ScheduleRepository } from '../storage/repositories/schedule-repository.js';
import { TaskRepository } from '../storage/repositories/task-repository.js';
import { createContentManager } from '../modules/content/content-manager.js';
import { ContentError } from '../modules/content/constants.js';

/**
 * Open SQLite + content services for CLI commands (no browser required).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function openContentRuntime(options = {}) {
  const config = loadConfig(options.env ?? process.env);
  const database = new Database({ filePath: config.databasePath });
  database.open();

  const scheduleRepository = new ScheduleRepository(database);
  const taskRepository = new TaskRepository(database);
  const manager = createContentManager({
    database,
    config,
    scheduleRepository,
    taskRepository,
  });

  return {
    config,
    database,
    scheduleRepository,
    taskRepository,
    ...manager,
    close() {
      database.close();
    },
  };
}

/**
 * @param {unknown} error
 */
export function contentErrorPayload(error) {
  if (error instanceof ContentError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: error.code,
        details: error.details,
      },
    };
  }
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: 'UNEXPECTED',
    },
  };
}

export { ContentError };
