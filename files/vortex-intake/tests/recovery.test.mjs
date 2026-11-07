import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntakeError } from '../adapter/contract.mjs';
import { Ledger } from '../adapter/ledger.mjs';
import { PlaneError } from '../adapter/plane.mjs';
import { payload, issueId, textFile, setup } from './helpers.mjs';

test('JSON completion and replay survive a restart without duplicating the issue', async (t) => {
  const ctx = setup(t);
  assert.deepEqual(await ctx.intake.submit(payload), { status: 200, body: { schema_version: 2, request_id: payload.request_id, status: 'completed', work_item_id: issueId, attachment_id: null, logs_ref: null } });
  ctx.restart();
  await ctx.intake.submit({ ...payload, reported_at: 'later' });
  assert.equal(ctx.plane.count('createIssue'), 1);
  await assert.rejects(ctx.intake.submit({ ...payload, title: 'Changed' }), { code: 'request_id_conflict' });
});
test('upload failure retries only the attachment and keeps confirmed issue ID', async (t) => {
  const ctx = setup(t); ctx.plane.fail('upload', new IntakeError(502, 'storage_unavailable'));
  await assert.rejects(ctx.intake.submit(payload, textFile()));
  assert.equal(ctx.ledger.get(payload.request_id).files.attachment.stage, 'uploading');
  ctx.restart();
  const result = await ctx.intake.submit(payload, textFile());
  assert.equal(result.status, 200); assert.ok(result.body.attachment_id);
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.count('createAttachment'), 1); assert.equal(ctx.plane.count('upload'), 2);
  assert.equal(ctx.ledger.get(payload.request_id).files.attachment.upload, undefined);
});
test('confirm response lost: restart reads confirmation and never reuploads', async (t) => {
  const ctx = setup(t); ctx.plane.fail('confirm', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(payload, textFile()));
  ctx.restart(); await ctx.intake.submit(payload, textFile());
  assert.equal(ctx.plane.count('upload'), 1); assert.equal(ctx.plane.count('confirm'), 1);
});
test('issue created but response lost: reconcile by external ID after restart', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createIssue', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(payload, textFile()));
  ctx.restart(); await ctx.intake.submit(payload, textFile());
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.count('findIssue'), 1);
});
test('unknown create outcome with no match fails closed across repeated retries', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createIssue', new PlaneError(0));
  await assert.rejects(ctx.intake.submit(payload)); ctx.restart();
  for (let i = 0; i < 3; i++) await assert.rejects(ctx.intake.submit(payload), { code: 'issue_outcome_unknown', status: 503 });
  assert.equal(ctx.plane.count('createIssue'), 1);
});
test('known rejected create can be retried without an uncertain-outcome latch', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createIssue', new PlaneError(429));
  await assert.rejects(ctx.intake.submit(payload)); await ctx.intake.submit(payload);
  assert.equal(ctx.plane.issues.length, 1);
});
test('lost attachment allocation response is recovered without duplicating issue', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createAttachment', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(payload, textFile())); ctx.restart();
  await ctx.intake.submit(payload, textFile());
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.count('findAttachment'), 1);
  assert.equal(ctx.plane.attachments.length, 1); assert.equal(ctx.plane.attachments[0].is_uploaded, true);
});
test('unknown attachment allocation is not blindly repeated', async (t) => {
  const ctx = setup(t); ctx.plane.fail('createAttachment', new PlaneError(0));
  await assert.rejects(ctx.intake.submit(payload, textFile()));
  await assert.rejects(ctx.intake.submit(payload, textFile()), { code: 'attachment_outcome_unknown' });
  assert.equal(ctx.plane.count('createAttachment'), 1);
});
test('expired upload credentials replace only an unfinished allocation', async (t) => {
  const ctx = setup(t); ctx.plane.fail('upload', new IntakeError(503, 'upload_credentials_expired'));
  await assert.rejects(ctx.intake.submit(payload, textFile()));
  ctx.plane.fail('deleteAttachment', new PlaneError(0), true);
  await assert.rejects(ctx.intake.submit(payload, textFile())); ctx.restart();
  await ctx.intake.submit(payload, textFile());
  assert.equal(ctx.plane.count('createIssue'), 1); assert.equal(ctx.plane.attachments.length, 1);
});
test('concurrent retry returns conflict while first execution is still running', async (t) => {
  const ctx = setup(t); let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const create = ctx.plane.createIssue.bind(ctx.plane);
  ctx.plane.createIssue = async (...args) => { await barrier; return create(...args); };
  const first = ctx.intake.submit(payload);
  await assert.rejects(ctx.intake.submit(payload), { code: 'request_in_progress' });
  release(); await first; assert.equal(ctx.plane.count('createIssue'), 1);
});
test('SQLite lock prevents a second adapter process using the volume', (t) => {
  const ctx = setup(t); assert.throws(() => new Ledger(ctx.directory));
});
test('rate limit counts new submissions, not retries or completed replays', async (t) => {
  const ctx = setup(t);
  for (let i = 1; i <= 5; i++) await ctx.intake.submit({ ...payload, request_id: `4b258dc1-9fa4-468d-8aac-${String(i).padStart(12,'0')}` });
  await assert.rejects(ctx.intake.submit(payload), { status: 429 });
  await ctx.intake.submit({ ...payload, request_id: '4b258dc1-9fa4-468d-8aac-000000000001' });
});
test('timeout returns no success and leaves recoverable creation intent', async (t) => {
  const ctx = setup(t, 10);
  ctx.plane.createIssue = async (body, signal) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 100);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new PlaneError(0)); }, { once: true });
  });
  await assert.rejects(ctx.intake.submit(payload), { status: 504 });
  assert.equal(ctx.ledger.get(payload.request_id).stage, 'creating_issue');
});
