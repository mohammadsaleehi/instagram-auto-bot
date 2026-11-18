import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { up as migration001, version as version001, name as name001 } from './migrations/001-initial.js';
import { up as migration002, version as version002, name as name002 } from './migrations/002-content.js';
import { up as migration003, version as version003, name as name003 } from './migrations/003-story.js';
import { up as migration004, version as version004, name as name004 } from './migrations/004-intelligence.js';

export const DEFAULT_DATABASE_PATH = './data/bot.sqlite';

export class DatabaseError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'DatabaseError';
    this.code = options.code ?? 'DATABASE_ERROR';
  }
}

/** @type {ReadonlyArray<{ version: number, name: string, up: (db: DatabaseSync) => void }>} */
const MIGRATIONS = Object.freeze([
  { version: version001, name: name001, up: migration001 },
  { version: version002, name: name002, up: migration002 },
  { version: version003, name: name003, up: migration003 },
  { version: version004, name: name004, up: migration004 },
]);

/**
 * @param {string} filePath
 * @param {{ mode?: number, recursive?: boolean }} [options]
 */
export function ensureParentDirectory(filePath, options = {}) {
  const dir = path.dirname(filePath);
  const mode = options.mode ?? 0o700;
  fs.mkdirSync(dir, { recursive: options.recursive ?? true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
}

/**
 * Restrict database file permissions to the current user.
 *
 * @param {string} filePath
 * @param {number} [mode=0o600]
 */
export function restrictFilePermissions(filePath, mode = 0o600) {
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, mode);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Open (or create) the application SQLite database and apply migrations.
 */
export class Database {
  /**
   * @param {{
   *   filePath?: string,
   *   logger?: {
   *     info?: (message: string, meta?: Record<string, unknown>) => void,
   *     warn?: (message: string, meta?: Record<string, unknown>) => void,
   *     error?: (message: string, meta?: Record<string, unknown>) => void,
   *     debug?: (message: string, meta?: Record<string, unknown>) => void,
   *   },
   *   readOnly?: boolean,
   * }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? ':memory:';
    this.logger = options.logger ?? null;
    this.readOnly = options.readOnly ?? false;
    /** @type {DatabaseSync | null} */
    this._db = null;
  }

  /**
   * @returns {boolean}
   */
  isOpen() {
    return this._db !== null;
  }

  /**
   * @returns {DatabaseSync}
   */
  get raw() {
    if (!this._db) {
      throw new DatabaseError('Database is not open', { code: 'DB_CLOSED' });
    }
    return this._db;
  }

  /**
   * @returns {DatabaseSync}
   */
  open() {
    if (this._db) {
      return this._db;
    }

    if (this.filePath !== ':memory:') {
      ensureParentDirectory(this.filePath);
    }

    try {
      this._db = new DatabaseSync(this.filePath, {
        readOnly: this.readOnly,
      });
    } catch (error) {
      throw new DatabaseError(
        `Failed to open SQLite database at ${this.filePath}`,
        { code: 'DB_OPEN_FAILED', cause: error },
      );
    }

    if (!this.readOnly) {
      this._db.exec('PRAGMA foreign_keys = ON;');
      this._db.exec('PRAGMA journal_mode = WAL;');
      this._db.exec('PRAGMA busy_timeout = 5000;');
      this.migrate();
      if (this.filePath !== ':memory:') {
        restrictFilePermissions(this.filePath);
        restrictFilePermissions(`${this.filePath}-wal`);
        restrictFilePermissions(`${this.filePath}-shm`);
      }
    }

    this.logger?.info?.('SQLite database ready', {
      path: this.filePath === ':memory:' ? ':memory:' : this.filePath,
      readOnly: this.readOnly,
    });

    return this._db;
  }

  /**
   * Apply pending schema migrations inside a transaction.
   *
   * @returns {{ applied: string[], currentVersion: number }}
   */
  migrate() {
    const db = this.raw;
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
    );

    /** @type {string[]} */
    const newlyApplied = [];

    const apply = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        apply.run(migration.version, migration.name, new Date().toISOString());
        db.exec('COMMIT');
        newlyApplied.push(migration.name);
        this.logger?.info?.('Applied database migration', {
          version: migration.version,
          name: migration.name,
        });
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw new DatabaseError(`Migration ${migration.name} failed`, {
          code: 'MIGRATION_FAILED',
          cause: error,
        });
      }
    }

    return {
      applied: newlyApplied,
      currentVersion: this.getSchemaVersion(),
    };
  }

  /**
   * @returns {number}
   */
  getSchemaVersion() {
    const row = this.raw
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get();
    return Number(row?.version ?? 0);
  }

  /**
   * Run a callback inside an IMMEDIATE transaction.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    const db = this.raw;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  /**
   * Integrity check used by doctor / health.
   *
   * @returns {{ ok: boolean, detail: string }}
   */
  checkIntegrity() {
    try {
      const row = this.raw.prepare('PRAGMA integrity_check').get();
      const detail = String(row?.integrity_check ?? row?.['integrity_check'] ?? Object.values(row ?? {})[0] ?? 'unknown');
      return {
        ok: detail.toLowerCase() === 'ok',
        detail,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * @returns {void}
   */
  close() {
    if (!this._db) {
      return;
    }

    try {
      this._db.close();
    } catch (error) {
      throw new DatabaseError('Failed to close SQLite database', {
        code: 'DB_CLOSE_FAILED',
        cause: error,
      });
    } finally {
      this._db = null;
    }
  }
}

/**
 * Resolve a database path relative to the project root.
 *
 * @param {string | undefined} value
 * @param {string} projectRoot
 * @param {string} [fallback=DEFAULT_DATABASE_PATH]
 * @returns {string}
 */
export function resolveDatabasePath(value, projectRoot, fallback = DEFAULT_DATABASE_PATH) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  if (raw === ':memory:') {
    return ':memory:';
  }
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

export { MIGRATIONS };
