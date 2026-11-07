import { IntakeError, UUID } from './contract.mjs';

const SOURCE = 'vortex-intake';

export class PlaneError extends IntakeError {
  constructor(upstreamStatus) {
    super(502, 'plane_unavailable');
    this.upstreamStatus = upstreamStatus;
    this.definitelyRejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(upstreamStatus);
  }
}

export class PlaneClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.base = `${config.baseUrl}/api/v2/workspaces/${encodeURIComponent(config.workspace)}/projects/${encodeURIComponent(config.project)}/work-items/`;
  }

  async request(path, method, body, signal) {
    let response;
    try {
      response = await this.fetch(this.base + path, {
        method, redirect: 'error', signal,
        headers: { 'X-Api-Key': this.config.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new PlaneError(0); // Unknown commit outcome. Never automatically repeat a create.
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlaneError(response.status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new PlaneError(0); }
  }

  async list(path, query, signal) {
    const results = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ ...query, per_page: '200', offset: String(offset) });
      const result = await this.request(`${path}?${params}`, 'GET', null, signal);
      if (Array.isArray(result)) return [...results, ...result];
      if (!Array.isArray(result?.data)) throw new IntakeError(502, 'invalid_plane_response');
      results.push(...result.data);
      if (result.next === null) return results;
      // Do not mistake an unknown/incomplete pagination envelope for absence.
      if (!Number.isInteger(result.next) || result.next <= offset) throw new IntakeError(502, 'invalid_plane_pagination');
      offset = result.next;
    }
    throw new IntakeError(503, 'reconciliation_incomplete');
  }

  async findIssue(externalId, signal) {
    const items = await this.list('', { external_id: externalId, external_source: SOURCE, archived: 'true', fields: 'id,external_id,external_source,sequence_id' }, signal);
    return unique(items, externalId);
  }

  async createIssue(body, signal) {
    const result = await this.request('', 'POST', body, signal);
    if (!UUID.test(result?.id ?? '')) throw new IntakeError(502, 'invalid_plane_response');
    return { id: result.id, sequenceId: Number.isInteger(result.sequence_id) ? result.sequence_id : null };
  }

  async issueSequence(issueId, signal) {
    const result = await this.request(`${issueId}/`, 'GET', null, signal);
    if (result?.id !== issueId || !Number.isInteger(result.sequence_id)) throw new IntakeError(502, 'invalid_plane_response');
    return result.sequence_id;
  }

  // Full replacement of description_html: repeating it is harmless.
  async updateDescription(issueId, descriptionHtml, signal) {
    await this.request(`${issueId}/`, 'PATCH', { description_html: descriptionHtml }, signal);
  }

  async findAttachment(issueId, externalId, signal) {
    return unique(await this.list(`${issueId}/attachments/`, {}, signal), externalId);
  }

  async attachment(issueId, attachmentId, signal) {
    const result = await this.request(`${issueId}/attachments/${attachmentId}/`, 'GET', null, signal);
    if (result?.id !== attachmentId || typeof result.is_uploaded !== 'boolean') throw new IntakeError(502, 'invalid_plane_response');
    return result;
  }

  async createAttachment(issueId, externalId, file, signal) {
    const result = await this.request(`${issueId}/attachments/`, 'POST', {
      name: file.name, size: file.size, type: file.type, external_id: externalId, external_source: SOURCE,
    }, signal);
    if (!UUID.test(result?.asset_id ?? '')) throw new IntakeError(502, 'invalid_plane_response');
    this.validateUpload(result.upload_data);
    return { id: result.asset_id, upload: result.upload_data };
  }

  validateUpload(upload) {
    let url;
    try { url = new URL(upload?.url); } catch { throw new IntakeError(502, 'invalid_storage_url'); }
    if (!this.config.storageOrigins.includes(url.origin) || url.username || url.password || url.hash ||
        !['https:', 'http:'].includes(url.protocol)) throw new IntakeError(502, 'invalid_storage_url');
    if (!upload.fields || typeof upload.fields !== 'object' || Array.isArray(upload.fields) ||
        Object.keys(upload.fields).length === 0 || Object.keys(upload.fields).length > 32 ||
        Object.entries(upload.fields).some(([key, value]) => key === 'file' || typeof value !== 'string' || value.length > 16384)) {
      throw new IntakeError(502, 'invalid_storage_fields');
    }
  }

  async upload(upload, file, signal) {
    this.validateUpload(upload);
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
    let response;
    try {
      response = await this.fetch(upload.url, { method: 'POST', body: form, redirect: 'error', signal });
    } catch { throw new IntakeError(502, 'storage_unavailable'); }
    await response.body?.cancel();
    if (response.status === 403) throw new IntakeError(503, 'upload_credentials_expired');
    if (![200, 201, 204].includes(response.status)) throw new IntakeError(502, 'storage_unavailable');
  }

  async confirm(issueId, attachmentId, signal) {
    await this.request(`${issueId}/attachments/${attachmentId}/`, 'PATCH', { is_uploaded: true }, signal);
    const result = await this.attachment(issueId, attachmentId, signal);
    if (!result.is_uploaded) throw new IntakeError(502, 'attachment_not_confirmed');
  }

  async deleteAttachment(issueId, attachmentId, signal) {
    try { await this.request(`${issueId}/attachments/${attachmentId}/`, 'DELETE', null, signal); }
    catch (error) { if (error.upstreamStatus !== 404) throw error; }
  }
}

function unique(items, externalId) {
  const matches = items.filter((item) => item.external_id === externalId && item.external_source === SOURCE);
  if (matches.length > 1) throw new IntakeError(409, 'reconciliation_required');
  if (matches.length && !UUID.test(matches[0].id ?? '')) throw new IntakeError(502, 'invalid_plane_response');
  return matches[0] ?? null;
}
