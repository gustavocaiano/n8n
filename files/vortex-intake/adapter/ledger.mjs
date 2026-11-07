import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IntakeError } from './contract.mjs';

export class Ledger {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    // A separate SQLite OS lock enforces one service process per volume. The
    // kernel releases it after a crash; it doesn't block commits to the ledger.
    this.owner = new DatabaseSync(join(directory, 'owner.sqlite'));
    try {
      this.owner.exec('BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(join(directory, 'intake.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS buckets (key TEXT PRIMARY KEY, tokens REAL NOT NULL, ts INTEGER NOT NULL);`);
    } catch (error) {
      this.db?.close();
      this.owner.close();
      throw error;
    }
  }

  get(key) {
    const row = this.db.prepare('SELECT fingerprint, state FROM requests WHERE key = ?').get(key);
    return row ? { fingerprint: row.fingerprint, ...JSON.parse(row.state) } : null;
  }

  start(input, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let state = this.get(input.key);
      if (state && state.fingerprint !== input.fingerprint) throw new IntakeError(409, 'request_id_conflict');
      if (!state) {
        const bucketKey = input.data.instance.name || 'default';
        const bucket = this.db.prepare('SELECT tokens, ts FROM buckets WHERE key = ?').get(bucketKey);
        const tokens = bucket ? Math.min(5, bucket.tokens + Math.max(0, now - bucket.ts) * 5 / 3_600_000) : 5;
        if (tokens < 1) throw new IntakeError(429, 'rate_limited');
        this.db.prepare('INSERT OR REPLACE INTO buckets VALUES (?, ?, ?)').run(bucketKey, tokens - 1, now);
        state = { stage: 'new', issueId: null, files: {}, fingerprint: input.fingerprint };
        this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(input.key, input.fingerprint, JSON.stringify(state));
      }
      this.db.exec('COMMIT');
      return state;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  save(key, state) {
    const result = this.db.prepare('UPDATE requests SET state = ? WHERE key = ?').run(JSON.stringify(state), key);
    if (result.changes !== 1) throw new Error('Missing ledger request');
  }

  close() {
    this.db.close();
    this.owner.close();
  }
}
