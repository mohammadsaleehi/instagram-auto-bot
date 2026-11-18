/**
 * Simple key/value settings persisted in SQLite.
 */
export class SettingsRepository {
  /**
   * @param {import('../database.js').Database} database
   * @param {{ nowFn?: () => Date }} [options]
   */
  constructor(database, options = {}) {
    this.db = database;
    this._now = options.nowFn ?? (() => new Date());
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  get(key) {
    const row = this.db.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    const now = this._now().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    const result = this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /**
   * @returns {Record<string, string>}
   */
  getAll() {
    const rows = this.db.raw.prepare('SELECT key, value FROM settings').all();
    /** @type {Record<string, string>} */
    const result = {};
    for (const row of rows) {
      result[String(row.key)] = String(row.value);
    }
    return result;
  }
}
