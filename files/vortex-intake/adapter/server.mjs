import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { IntakeError, MAX_BODY_BYTES, errorResponse } from './contract.mjs';
import { Intake } from './intake.mjs';
import { Ledger } from './ledger.mjs';
import { PlaneClient } from './plane.mjs';

export async function parseBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new IntakeError(413, 'request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new IntakeError(413, 'request_too_large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (/^application\/json(?:;|$)/i.test(type)) {
    if (body.length > 65_536) throw new IntakeError(413, 'payload_too_large');
    try { return { payload: JSON.parse(body.toString('utf8')), file: null }; }
    catch { throw new IntakeError(400, 'invalid_json'); }
  }
  if (!/^multipart\/form-data(?:;|$)/i.test(type)) throw new IntakeError(415, 'unsupported_transport');
  let form;
  try {
    form = await new Request('http://localhost/intake', { method: 'POST', headers: { 'content-type': type }, body }).formData();
  } catch { throw new IntakeError(400, 'invalid_multipart'); }
  if (form.getAll('payload').length !== 1 || form.getAll('attachment').length !== 1 ||
      [...form.keys()].some((key) => !['payload', 'attachment'].includes(key))) throw new IntakeError(422, 'invalid_parts');
  const value = form.get('payload');
  const file = form.get('attachment');
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536 || typeof file === 'string') throw new IntakeError(422, 'invalid_parts');
  let payload;
  try { payload = JSON.parse(value); } catch { throw new IntakeError(400, 'invalid_json'); }
  return { payload, file: { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) } };
}

function authorized(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createIntakeServer(intake, token, logger = console) {
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    function send(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...([409, 429, 503, 504].includes(status) ? { 'Retry-After': status === 429 ? '720' : '2' } : {}) });
      res.end(JSON.stringify(body));
    }
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/intake') return send(404, { status: 'error', code: 'not_found' });
    if (!authorized(req.headers['x-vortex-intake-token'], token)) return send(401, { status: 'error', code: 'unauthorized' });
    let payload;
    try {
      const parsed = await parseBody(req);
      payload = parsed.payload;
      const result = await intake.submit(payload, parsed.file);
      send(result.status, result.body);
    } catch (error) {
      req.resume();
      // Preserve the intentional legacy honeypot drop, but never forge a v2 completion.
      if (error.code === 'honeypot' && payload?.schema_version === undefined && payload?.request_id === undefined) {
        return send(200, { status: 'ignored' });
      }
      const result = errorResponse(error, payload);
      logger.warn(JSON.stringify({ event: 'vortex_intake_failed', http_status: result.status,
        code: result.body.code, request_id: result.body.request_id ?? null }));
      send(result.status, result.body);
    }
  });
}

export function configFromEnv(env) {
  const config = {
    baseUrl: env.VORTEX_INTAKE_PLANE_URL?.replace(/\/$/, ''),
    workspace: env.VORTEX_INTAKE_PLANE_WORKSPACE,
    project: env.VORTEX_INTAKE_PLANE_PROJECT,
    apiKey: env.VORTEX_INTAKE_PLANE_API_KEY,
    bugLabel: env.VORTEX_INTAKE_BUG_LABEL,
    featureLabel: env.VORTEX_INTAKE_FEATURE_LABEL,
    token: env.VORTEX_INTAKE_TOKEN,
    directory: env.VORTEX_INTAKE_DATA_DIR || '/data',
  };
  if (!config.baseUrl || !config.workspace || !config.project || !config.apiKey || !config.token ||
      /CHANGE-ME|change-me|xxxxx/.test(config.apiKey + config.token)) throw new Error('Missing intake configuration');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Plane origin');
  config.storageOrigins = (env.VORTEX_INTAKE_STORAGE_ORIGINS || url.origin).split(',').map((origin) => {
    const parsed = new URL(origin.trim());
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin.trim()) throw new Error('Invalid storage origin');
    return parsed.origin;
  });
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const config = configFromEnv(process.env);
    const ledger = new Ledger(config.directory);
    const intake = new Intake(ledger, new PlaneClient(config), config);
    const server = createIntakeServer(intake, config.token);
    server.listen(8086, '0.0.0.0', () => console.log('vortex-intake listening on :8086'));
    for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => {
      server.close(() => { ledger.close(); process.exit(0); });
    });
  } catch {
    console.error('vortex-intake startup failed: verify configuration, volume permissions and single-instance lock');
    process.exitCode = 1;
  }
}
