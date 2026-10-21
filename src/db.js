import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const done = [];
  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) return done;
  // Table rebuilds need foreign keys off; integrity is checked before they are turned back on.
  db.pragma('foreign_keys = OFF');
  try {
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        const broken = db.pragma('foreign_key_check');
        if (broken.length) throw new Error(`Migration ${file} broke foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
      })();
      done.push(file);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return done;
}

/** Run fn inside BEGIN IMMEDIATE so concurrent writers serialize before reading. */
export function tx(db, fn) {
  return db.transaction(fn).immediate();
}
