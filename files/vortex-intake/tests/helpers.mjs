import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../adapter/ledger.mjs';
import { Intake } from '../adapter/intake.mjs';
import { PlaneError } from '../adapter/plane.mjs';
import { LogStore } from '../adapter/logstore.mjs';
import { LinkStore } from '../adapter/links.mjs';

export const config = { baseUrl: 'https://plane.invalid', workspace: 'test', project: 'test', apiKey: 'not-a-secret-test-only',
  storageOrigins: ['https://storage.invalid'], bugLabel: 'bug-label', featureLabel: 'feature-label' };
export const payload = { schema_version: 2, request_id: '4b258dc1-9fa4-468d-8aac-107142d6fb11', type: 'bug', title: 'Teste de anexo',
  description: 'Um exemplo local, sem dados pessoais.', version: '3.1.0', instance: { name: 'NUC de teste', url: 'https://nuc.invalid' },
  user: { name: 'Utilizador de teste', username: 'teste' }, reported_at: '2026-11-05T12:00:00+00:00', website: '' };
export const issueId = '8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13';
export function fixture(name, type) {
  return { name, type, bytes: readFileSync(new URL(`../fixtures/${name}`, import.meta.url)) };
}
export const textFile = () => fixture('sample.txt', 'text/plain');

export class FakePlane {
  constructor() { this.issues = []; this.attachments = []; this.calls = []; this.faults = {}; }
  fail(method, error, after = false) { this.faults[method] = { error, after }; }
  record(method, args) {
    this.calls.push({ method, args });
    const fault = this.faults[method];
    if (fault && !fault.after) { delete this.faults[method]; throw fault.error; }
  }
  after(method) {
    const fault = this.faults[method];
    if (fault?.after) { delete this.faults[method]; throw fault.error; }
  }
  count(method) { return this.calls.filter((call) => call.method === method).length; }
  async findIssue(key) { this.record('findIssue', [key]); return this.issues.find((x) => x.external_id === key) ?? null; }
  async createIssue(body) {
    this.record('createIssue', [body]); this.issues.push({ ...body, id: issueId, sequence_id: 14 }); this.after('createIssue');
    return { id: issueId, sequenceId: 14 };
  }
  async issueSequence(id) { this.record('issueSequence', [id]); return this.issues.find((x) => x.id === id).sequence_id; }
  async updateDescription(id, html) {
    this.record('updateDescription', [id, html]); this.issues.find((x) => x.id === id).description_html = html; this.after('updateDescription');
  }
  async findAttachment(id, key) { this.record('findAttachment', [id, key]); return this.attachments.find((x) => x.external_id === key) ?? null; }
  async createAttachment(id, key, file) {
    this.record('createAttachment', [id, key, file]);
    const attachment = { id: `37b14dc6-ef98-4dfc-a337-${String(this.count('createAttachment')).padStart(12, '0')}`, external_id: key, is_uploaded: false };
    this.attachments.push(attachment); this.after('createAttachment');
    return { id: attachment.id, upload: { url: 'https://storage.invalid', fields: { key: 'fake-key' } } };
  }
  async attachment(id, aid) {
    this.record('attachment', [id, aid]);
    const found = this.attachments.find((x) => x.id === aid);
    if (!found) throw new PlaneError(404);
    return { ...found };
  }
  async upload(upload, file) { this.record('upload', [upload, file]); this.after('upload'); }
  async confirm(id, aid) {
    this.record('confirm', [id, aid]); this.attachments.find((x) => x.id === aid).is_uploaded = true; this.after('confirm');
  }
  async deleteAttachment(id, aid) {
    this.record('deleteAttachment', [id, aid]); this.attachments = this.attachments.filter((x) => x.id !== aid); this.after('deleteAttachment');
  }
}

export const logsText = '# Vortex 3x-beta logs (48 h)\n[2026-11-07 09:00:00] local.ERROR: exemplo\n\tat linha\r\n';
export function logsFile(text = logsText) {
  return { name: 'vortex-logs-48h.txt', type: 'text/plain; charset=utf-8', bytes: Buffer.from(text) };
}
export function withLogs(file = logsFile(), extra = {}) {
  return { ...payload, logs: { included: true, hours: 48, bytes: file.bytes.length, truncated: false, ...extra } };
}

export const linkBase = 'https://logs.invalid/vortex-logs/';
export function setup(t, budget = 20_000, { links: withLinks = false, clock = { now: Date.now() } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vortex-intake-test-'));
  let ledger = new Ledger(directory);
  let links = new LinkStore(ledger.db);
  const plane = new FakePlane();
  const logStore = new LogStore(join(directory, 'logs'));
  const intakeConfig = withLinks ? { ...config, logsLinkBase: linkBase, logsLinkTtlDays: 15 } : config;
  const make = () => new Intake(ledger, plane, intakeConfig, budget, { logStore, links, now: () => clock.now });
  let intake = make();
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, plane, clock, get ledger() { return ledger; }, get intake() { return intake; }, get links() { return links; },
    logStore, logsDir: join(directory, 'logs'),
    restart() { ledger.close(); ledger = new Ledger(directory); links = new LinkStore(ledger.db); intake = make(); } };
}
