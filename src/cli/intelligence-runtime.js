import { loadConfig } from '../config/config.js';
import { Database } from '../storage/database.js';
import { TaskRepository } from '../storage/repositories/task-repository.js';
import { createIntelligenceManager } from '../intelligence/intelligence-manager.js';
import { IntelligenceError } from '../intelligence/constants.js';

/**
 * Open SQLite + Intelligence Core for CLI commands (no browser required).
 *
 * @param {{ env?: NodeJS.ProcessEnv, provider?: any }} [options]
 */
export function openIntelligenceRuntime(options = {}) {
  const config = loadConfig(options.env ?? process.env);
  const database = new Database({ filePath: config.databasePath });
  database.open();
  const taskRepository = new TaskRepository(database);
  const manager = createIntelligenceManager({
    database,
    config,
    taskRepository,
    provider: options.provider,
  });

  return {
    config,
    database,
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
export function intelligenceErrorPayload(error) {
  if (error instanceof IntelligenceError) {
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

export { IntelligenceError };
