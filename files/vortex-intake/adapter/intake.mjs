import { IntakeError, normalize, planeIssue, completed } from './contract.mjs';

export class Intake {
  constructor(ledger, plane, config, budgetMs = 20_000) {
    this.ledger = ledger;
    this.plane = plane;
    this.config = config;
    this.budgetMs = budgetMs;
    this.active = new Set();
  }

  async submit(payload, file) {
    const input = normalize(payload, file);
    if (this.active.has(input.key)) throw new IntakeError(409, 'request_in_progress');
    this.active.add(input.key);
    const signal = AbortSignal.timeout(this.budgetMs);
    try {
      const state = this.ledger.start(input);
      if (state.stage === 'completed') return completed(input, state);
      await this.deliver(input, state, signal);
      state.stage = 'completed';
      delete state.upload;
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
    state.stage = stage;
    this.ledger.save(input.key, state);
  }

  async deliver(input, state, signal) {
    const issue = planeIssue(input, this.config);
    if (state.stage === 'creating_issue') {
      const found = await this.plane.findIssue(issue.external_id, signal);
      if (!found) throw new IntakeError(503, 'issue_outcome_unknown');
      state.issueId = found.id;
      this.save(input, state, 'issue_created');
    }
    if (state.stage === 'new') {
      // Commit intent BEFORE the remote write: after a crash/timeout only look up.
      this.save(input, state, 'creating_issue');
      try { state.issueId = await this.plane.createIssue(issue, signal); }
      catch (error) {
        if (error.definitelyRejected) this.save(input, state, 'new');
        throw error;
      }
      this.save(input, state, 'issue_created');
    }
    if (!input.attachment) return;
    const attachmentKey = () => `vortex-${input.key}-file-${state.generation}`;
    if (state.stage === 'creating_attachment') {
      const found = await this.plane.findAttachment(state.issueId, attachmentKey(), signal);
      if (!found) throw new IntakeError(503, 'attachment_outcome_unknown');
      state.attachmentId = found.id;
      if (found.is_uploaded === true) return;
      if (found.is_uploaded !== false) throw new IntakeError(502, 'invalid_plane_response');
      // The create response was lost: recover the ID, then replace the unfinished
      // allocation, since GET doesn't return the presigned upload credentials.
      this.save(input, state, 'replacing_attachment');
    }
    if (state.stage === 'replacing_attachment') {
      const existing = await this.readAttachmentOrMissing(state, signal);
      if (existing?.is_uploaded) return;
      await this.plane.deleteAttachment(state.issueId, state.attachmentId, signal);
      state.attachmentId = null;
      delete state.upload;
      state.generation += 1;
      this.save(input, state, 'issue_created');
    }
    if (state.stage === 'issue_created') {
      this.save(input, state, 'creating_attachment');
      try {
        const created = await this.plane.createAttachment(state.issueId, attachmentKey(), input.attachment, signal);
        state.attachmentId = created.id;
        state.upload = created.upload;
      } catch (error) {
        if (error.definitelyRejected) this.save(input, state, 'issue_created');
        throw error;
      }
      this.save(input, state, 'uploading');
    }
    if (state.stage === 'uploading') {
      try { await this.plane.upload(state.upload, input.attachment, signal); }
      catch (error) {
        if (error.code === 'upload_credentials_expired') this.save(input, state, 'replacing_attachment');
        throw error;
      }
      this.save(input, state, 'confirming');
    }
    if (state.stage === 'confirming') {
      const existing = await this.plane.attachment(state.issueId, state.attachmentId, signal);
      if (!existing.is_uploaded) await this.plane.confirm(state.issueId, state.attachmentId, signal);
    }
  }

  async readAttachmentOrMissing(state, signal) {
    try { return await this.plane.attachment(state.issueId, state.attachmentId, signal); }
    catch (error) { if (error.upstreamStatus === 404) return null; throw error; }
  }
}
