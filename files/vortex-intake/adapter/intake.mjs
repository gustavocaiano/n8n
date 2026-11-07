import { IntakeError, normalize, planeIssue, completed, logsNote } from './contract.mjs';
import { LogStore } from './logstore.mjs';

// Plane attachments, each with its own resumable stage. Logs are NOT a slot:
// they are stored locally (LogStore) and only a note is added to the work item.
const SLOTS = [{ name: 'attachment', suffix: 'file' }];
const FILE_STAGES = ['creating_attachment', 'replacing_attachment', 'uploading', 'confirming'];

export class Intake {
  constructor(ledger, plane, config, budgetMs = 20_000, { logsBudgetMs = 45_000, logStore = null } = {}) {
    this.ledger = ledger;
    this.plane = plane;
    this.config = config;
    this.budgetMs = budgetMs;
    this.logsBudgetMs = logsBudgetMs;
    this.logStore = logStore;
    this.active = new Set();
  }

  async submit(payload, file, logs = null) {
    const input = normalize(payload, file, logs);
    if (input.logs && !this.logStore) throw new IntakeError(503, 'logs_storage_unavailable');
    if (this.active.has(input.key)) throw new IntakeError(409, 'request_in_progress');
    this.active.add(input.key);
    // Logs requests get the larger budget matching Vortex's 60s client timeout.
    const signal = AbortSignal.timeout(input.logs ? this.logsBudgetMs : this.budgetMs);
    try {
      const state = migrate(this.ledger.start(input));
      if (state.stage === 'completed') return completed(input, state);
      await this.deliver(input, state, signal);
      state.stage = 'completed';
      this.ledger.save(input.key, state);
      return completed(input, state);
    } catch (error) {
      if (signal.aborted) throw new IntakeError(504, 'delivery_timeout');
      throw error;
    } finally {
      this.active.delete(input.key);
    }
  }

  save(input, state, stage) {
    if (stage) state.stage = stage;
    this.ledger.save(input.key, state);
  }

  async deliver(input, state, signal) {
    const issue = planeIssue(input, this.config);
    if (state.stage === 'creating_issue') {
      const found = await this.plane.findIssue(issue.external_id, signal);
      if (!found) throw new IntakeError(503, 'issue_outcome_unknown');
      state.issueId = found.id;
      if (Number.isInteger(found.sequence_id)) state.issueSequence = found.sequence_id;
      this.save(input, state, 'issue_created');
    }
    if (state.stage === 'new') {
      // Commit intent BEFORE the remote write: after a crash/timeout only look up.
      this.save(input, state, 'creating_issue');
      try {
        const created = await this.plane.createIssue(issue, signal);
        state.issueId = created.id;
        if (Number.isInteger(created.sequenceId)) state.issueSequence = created.sequenceId;
      }
      catch (error) {
        if (error.definitelyRejected) this.save(input, state, 'new');
        throw error;
      }
      this.save(input, state, 'issue_created');
    }
    if (input.logs) await this.storeLogs(input, state, issue, signal);
    for (const slot of SLOTS) {
      const file = input[slot.name];
      if (!file) continue;
      state.files[slot.name] ??= { stage: 'pending', attachmentId: null, generation: 0 };
      await this.deliverFile(input, state, state.files[slot.name], slot, file, signal);
    }
  }

  async deliverFile(input, state, entry, slot, file, signal) {
    const save = (stage) => { entry.stage = stage; this.save(input, state); };
    const externalId = () => `vortex-${input.key}-${slot.suffix}-${entry.generation}`;
    if (entry.stage === 'done') return;
    if (entry.stage === 'creating_attachment') {
      const found = await this.plane.findAttachment(state.issueId, externalId(), signal);
      if (!found) throw new IntakeError(503, 'attachment_outcome_unknown');
      entry.attachmentId = found.id;
      if (found.is_uploaded === true) return save('done');
      if (found.is_uploaded !== false) throw new IntakeError(502, 'invalid_plane_response');
      // The create response was lost: recover the ID, then replace the unfinished
      // allocation, since GET doesn't return the presigned upload credentials.
      save('replacing_attachment');
    }
    if (entry.stage === 'replacing_attachment') {
      const existing = await this.readAttachmentOrMissing(state.issueId, entry.attachmentId, signal);
      if (existing?.is_uploaded) return save('done');
      await this.plane.deleteAttachment(state.issueId, entry.attachmentId, signal);
      entry.attachmentId = null;
      delete entry.upload;
      entry.generation += 1;
      save('pending');
    }
    if (entry.stage === 'pending') {
      save('creating_attachment');
      try {
        const created = await this.plane.createAttachment(state.issueId, externalId(), file, signal);
        entry.attachmentId = created.id;
        entry.upload = created.upload;
      } catch (error) {
        if (error.definitelyRejected) save('pending');
        throw error;
      }
      save('uploading');
    }
    if (entry.stage === 'uploading') {
      try { await this.plane.upload(entry.upload, file, signal); }
      catch (error) {
        if (error.code === 'upload_credentials_expired') save('replacing_attachment');
        throw error;
      }
      save('confirming');
    }
    if (entry.stage === 'confirming') {
      const existing = await this.plane.attachment(state.issueId, entry.attachmentId, signal);
      if (!existing.is_uploaded) await this.plane.confirm(state.issueId, entry.attachmentId, signal);
      delete entry.upload; // Signed form is no longer needed once confirmed.
      save('done');
    }
  }

  // Ticket first, then the file named after it, then a note on the ticket.
  async storeLogs(input, state, issue, signal) {
    state.logs ??= { stage: 'pending', ref: null };
    if (state.logs.stage === 'noted') return;
    if (!Number.isInteger(state.issueSequence)) {
      state.issueSequence = await this.plane.issueSequence(state.issueId, signal);
      this.save(input, state);
    }
    if (state.logs.stage === 'pending') {
      const ref = LogStore.fileName(this.config.projectIdentifier || 'VORTEX', state.issueSequence, input.requestId);
      this.logStore.store(ref, input.logs.bytes);
      state.logs = { stage: 'stored', ref };
      this.save(input, state);
    }
    if (state.logs.stage === 'stored') {
      // Re-sending the full description is idempotent; Plane never gets the content.
      await this.plane.updateDescription(state.issueId, issue.description_html + logsNote(input, state.logs.ref), signal);
      state.logs.stage = 'noted';
      this.save(input, state);
    }
  }

  async readAttachmentOrMissing(issueId, attachmentId, signal) {
    try { return await this.plane.attachment(issueId, attachmentId, signal); }
    catch (error) { if (error.upstreamStatus === 404) return null; throw error; }
  }
}

// Ledger rows written before per-file state kept one attachment at the top level.
export function migrate(state) {
  if (state.files) return state;
  const legacyStage = FILE_STAGES.includes(state.stage);
  state.files = {};
  if (legacyStage || (state.stage === 'completed' && state.attachmentId)) {
    state.files.attachment = { stage: legacyStage ? state.stage : 'done', attachmentId: state.attachmentId ?? null,
      generation: state.generation ?? 0, ...(state.upload ? { upload: state.upload } : {}) };
  }
  if (legacyStage) state.stage = 'issue_created';
  delete state.attachmentId; delete state.generation; delete state.upload;
  return state;
}
