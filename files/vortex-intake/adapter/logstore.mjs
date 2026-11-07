import { closeSync, fsyncSync, mkdirSync, chmodSync, openSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { IntakeError, digest } from './contract.mjs';

export const DEFAULT_RETENTION_DAYS = 90;
const NAME = /^[A-Z][A-Z0-9]*-\d+_[0-9a-f-]{36}\.txt$/;

// Private, durable store for Vortex log snapshots. Never served over HTTP and
// never sent to Plane; retrieved by an operator with docker exec on the host.
export class LogStore {
  constructor(directory, retentionDays = DEFAULT_RETENTION_DAYS) {
    this.directory = directory;
    this.retentionMs = retentionDays * 86_400_000;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  static fileName(projectIdentifier, sequenceId, requestId) {
    const name = `${projectIdentifier}-${sequenceId}_${requestId.toLowerCase()}.txt`;
    if (!NAME.test(name)) throw new IntakeError(502, 'invalid_logs_ref');
    return name;
  }

  // Atomic and idempotent: same bytes → no-op; different bytes never overwrite.
  store(name, bytes) {
    if (!NAME.test(name)) throw new IntakeError(502, 'invalid_logs_ref');
    const target = join(this.directory, name);
    let existing = null;
    try { existing = readFileSync(target); } catch (error) { if (error.code !== 'ENOENT') throw storeError(); }
    if (existing) {
      if (digest(existing) !== digest(bytes)) throw new IntakeError(409, 'request_id_conflict');
      return;
    }
    const temp = join(this.directory, `.${name}.${process.pid}.tmp`);
    try {
      const fd = openSync(temp, 'w', 0o600);
      try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, target);
      const dir = openSync(this.directory, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch {
      rmSync(temp, { force: true });
      throw storeError();
    }
  }

  // Deletes snapshots (and stale temp files) older than the retention period.
  prune(now = Date.now()) {
    let removed = 0;
    for (const entry of readdirSync(this.directory)) {
      const temp = /^\..+\.tmp$/.test(entry);
      if (!NAME.test(entry) && !temp) continue;
      const path = join(this.directory, entry);
      try {
        // Temp files are leftovers of an interrupted write; a retry rewrites them.
        if (now - statSync(path).mtimeMs > (temp ? 3_600_000 : this.retentionMs)) { rmSync(path, { force: true }); removed++; }
      } catch { /* Concurrently removed. */ }
    }
    return removed;
  }
}

function storeError() {
  return new IntakeError(503, 'logs_storage_unavailable');
}
