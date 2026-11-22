// One SQLite file in the data directory (node:sqlite). The schema is built by
// numbered migrations; the table schema_version holds the last one applied.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export const MIGRATIONS: string[] = [
  // 1: accounts, sessions, votes, rate limits
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     github_id INTEGER NOT NULL UNIQUE,
     login TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   -- One verdict per person and image: scene + variant + pixel hash of the
   -- gallery shot. Voting the same image again replaces the vote.
   CREATE TABLE votes (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     scene TEXT NOT NULL,
     grp TEXT NOT NULL,
     title TEXT NOT NULL,
     variant TEXT NOT NULL,
     hash TEXT NOT NULL,
     gallery_generated TEXT NOT NULL,
     "commit" TEXT NOT NULL,
     version TEXT NOT NULL,
     verdict TEXT NOT NULL CHECK (verdict IN ('up','down','skip')),
     comment TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     UNIQUE(user_id, scene, variant, hash)
   );
   CREATE INDEX votes_newest ON votes(created_at DESC, id DESC);
   CREATE INDEX votes_scene ON votes(scene, variant);
   CREATE INDEX votes_user ON votes(user_id, created_at DESC);
   CREATE TABLE rate_limits (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   );`,
  // 2: soft dismiss of votes by the maintainer (admin API). A dismissed vote
  // counts nowhere and its image is back in the person's deck; voting it
  // again clears both columns. dismissed_by is the admin's identifier as
  // flowplan-admin sends it.
  `ALTER TABLE votes ADD COLUMN dismissed_at INTEGER;
   ALTER TABLE votes ADD COLUMN dismissed_by TEXT;
   CREATE INDEX votes_dismissed ON votes(dismissed_at) WHERE dismissed_at IS NOT NULL;`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const holder = globalThis as unknown as { voteDb?: { db: DatabaseSync; dir: string } };

export function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) db.exec("INSERT INTO schema_version(version) VALUES(0)");
  const current = Number(row?.version ?? 0);
  if (current > SCHEMA_VERSION) throw new Error(`Database schema ${current} is newer than this version (${SCHEMA_VERSION}).`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("UPDATE schema_version SET version=?").run(v + 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// The connection for the current data directory (a new one when it changed,
// which only tests do).
export function db(): DatabaseSync {
  const dir = config.dataDir();
  const open = holder.voteDb;
  if (open && open.dir === dir) return open.db;
  holder.voteDb?.db.close();
  mkdirSync(dir, { recursive: true });
  const conn = new DatabaseSync(join(/*turbopackIgnore: true*/ dir, "vote.db"));
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(conn);
  holder.voteDb = { db: conn, dir };
  return conn;
}
export function closeDb() {
  holder.voteDb?.db.close();
  holder.voteDb = undefined;
}

// Rows as plain objects (node:sqlite gives null-prototype ones, which React
// cannot hand to client components).
export const all = <T>(sql: string, ...params: SQLInputValue[]) => db().prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
export const one = <T>(sql: string, ...params: SQLInputValue[]) => {
  const row = db().prepare(sql).get(...params);
  return (row ? { ...row } : undefined) as T | undefined;
};
export const run = (sql: string, ...params: SQLInputValue[]) => db().prepare(sql).run(...params);
let depth = 0;
// Nested calls join the outer transaction.
export function transaction<T>(fn: () => T): T {
  const conn = db();
  if (depth > 0) return fn();
  conn.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
}
export const now = () => Date.now();
