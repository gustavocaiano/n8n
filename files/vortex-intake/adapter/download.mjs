import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { TOKEN, tokenHash } from './links.mjs';

// Public surface for one-time logs links. Separate listener from the private
// intake: it serves ONLY these routes, never reads a path from the request and
// never logs, echoes or stores the raw token.
//
//   GET/HEAD <base>         static page; never consumes (scanners, previews)
//   POST     <base>status   token in the body → non-consuming state
//   POST     <base>redeem   token in the body → the file, exactly once
const MAX_FORM_BYTES = 1024;
const MAX_CONCURRENT = 4;

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0, no-transform',
  Pragma: 'no-cache',
  Expires: '0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'interest-cohort=(), browsing-topics=()',
};

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}code,pre{background:#2a2a2a}}
button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}button[disabled]{cursor:default}
code,pre{background:#f1f1f1;padding:.1rem .3rem;border-radius:4px}pre{padding:.6rem;overflow-x:auto;white-space:pre-wrap}
#state{font-weight:600}`;

// Inline script: reads the token from the fragment and removes it from the
// address bar before anything else; delivery needs an explicit click.
const SCRIPT = `(function(){
var m=/(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash),t=m&&m[1];
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
document.addEventListener('DOMContentLoaded',function(){
var s=document.getElementById('state'),b=document.getElementById('go');
var label={available:'Disponível',used:'Já utilizado: o ficheiro foi entregue e apagado.',expired:'Expirado: o ficheiro foi (ou vai ser) apagado.',
in_use:'Uma entrega está em curso noutro pedido; tentar daqui a pouco.',unavailable:'Indisponível.',not_found:'Link inválido.'};
function show(x){s.textContent=x}
if(!t){show('Este endereço não contém um token válido (abrir o link completo a partir do ticket).');return}
function post(p){return fetch(p,{method:'POST',body:new URLSearchParams({token:t}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'})}
post('status').then(function(r){return r.json()}).then(function(j){
 if(j.state==='available'){show(label.available+' ('+j.bytes+' bytes, expira a '+j.expires_at.slice(0,10)+'). Descarregar consome o link.');b.disabled=false}
 else show(label[j.state]||'Indisponível.')}).catch(function(){show('Não foi possível consultar o estado.')});
b.addEventListener('click',function(){
 b.disabled=true;show('A transferir…');var name,sha,len;
 post('redeem').then(function(r){
  if(r.status!==200)return r.json().then(function(j){throw new Error(label[(j.code||'').replace('link_','')]||'Indisponível.')});
  name=r.headers.get('X-Vortex-Logs-Ref');sha=r.headers.get('X-Vortex-Logs-SHA256');len=+r.headers.get('Content-Length');return r.arrayBuffer()})
 .then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(d){
  var h=Array.prototype.map.call(new Uint8Array(d),function(x){return('0'+x.toString(16)).slice(-2)}).join('');
  if(h!==sha||buf.byteLength!==len)throw new Error('Ficheiro recebido incompleto ou corrompido (sha256 diferente). O link pode já estar consumido: contactar o operador.');
  var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([buf],{type:'text/plain'}));a.download=name;document.body.appendChild(a);a.click();
  show('Entregue e verificado (sha256 '+h.slice(0,12)+'…). Guardar o ficheiro: o link já não pode ser usado.')})})
 .catch(function(e){show(e.message||'A transferência falhou. Se o estado passar a «Já utilizado», contactar o operador.')})});
});
})();`;

const hash = (text) => createHash('sha256').update(text).digest('base64');
const PAGE_CSP = `default-src 'none'; script-src 'sha256-${hash(SCRIPT)}'; style-src 'sha256-${hash(STYLE)}'; ` +
  "connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function page() {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Logs Vortex</title>
<script>${SCRIPT}</script><style>${STYLE}</style></head><body>
<h1>Logs Vortex (link de utilização única)</h1>
<p id="state">A verificar…</p>
<p><button id="go" disabled>Descarregar</button></p>
<p>Abrir esta página não consome o link. O ficheiro é entregue <strong>uma única vez</strong>, após carregar em «Descarregar», e é apagado do servidor.
Links não usados expiram (no máximo 15 dias). Não reencaminhar este link.</p>
<h2>Agentes e scripts</h2>
<p>O token é o valor <code>t=</code> no fragmento (<code>#</code>) do link. Nunca o colocar no caminho/query do URL,
em argumentos de linha de comandos, logs, comentários ou no Plane. Primeiro consultar o estado (não consome):</p>
<pre>umask 077; printf 'token=%s' "$TOKEN" &gt; token.form
curl -fsS --proto =https -X POST --data-binary @token.form -H 'Content-Type: application/x-www-form-urlencoded' &lt;este URL sem #&gt;status</pre>
<p>Depois obter o ficheiro (consome o link), e verificar o tamanho e o sha256 contra os headers
<code>Content-Length</code> e <code>X-Vortex-Logs-SHA256</code>:</p>
<pre>curl -fsS --proto =https -X POST --data-binary @token.form -H 'Content-Type: application/x-www-form-urlencoded' \\
  -D headers.txt -o vortex-logs.txt &lt;este URL sem #&gt;redeem
rm -f token.form; sha256sum vortex-logs.txt; grep -i '^x-vortex-logs-sha256' headers.txt</pre>
<p>Respostas: 200 ficheiro; 404 <code>link_not_found</code>; 410 <code>link_used</code>/<code>link_expired</code>/<code>link_unavailable</code>;
409 <code>link_in_use</code> (repetir após <code>Retry-After</code>). Uma transferência interrompida antes de o servidor
terminar o envio repõe o link; depois disso, o HTTP não comprova a receção: não repetir sem verificar o hash.
Não imprimir o conteúdo dos logs em conversas ou tickets.</p>
</body></html>`;
}

export function normalizePeer(address = '') {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function createDownloadServer({ links, logStore, basePath = '/', allowedPeers = [], requireHttps = true,
  graceMs = 0, logger = console, now = Date.now }) {
  const html = page();
  let inFlight = 0;
  const route = (url) => {
    const path = url.split('?')[0];
    for (const prefix of [basePath, '/']) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '' || rest === 'status' || rest === 'redeem') return rest;
    }
    return path === '/robots.txt' ? 'robots' : null;
  };

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    // The intake shares this process: an unexpected error must never crash it.
    try { await handle(req, res); }
    catch {
      logger.warn(JSON.stringify({ event: 'vortex_logs_link_failed' }));
      if (!res.headersSent) { res.writeHead(503, { ...NO_STORE, 'Content-Type': 'application/json' }); res.end('{"status":"error","code":"unavailable"}'); }
      else res.destroy();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;

  async function handle(req, res) {
    const json = (status, body, extra = {}) => {
      res.writeHead(status, { ...NO_STORE, 'Content-Type': 'application/json', 'Content-Security-Policy': "default-src 'none'; sandbox", ...extra });
      res.end(JSON.stringify(body));
    };
    const peer = normalizePeer(req.socket.remoteAddress);
    if (allowedPeers.length && !allowedPeers.includes(peer)) { req.socket.destroy(); return; }
    const target = route(req.url ?? '');
    if (target === null) return json(404, { status: 'error', code: 'not_found' });
    if (requireHttps && req.headers['x-forwarded-proto'] !== 'https') return json(421, { status: 'error', code: 'https_required' });
    if (target === 'robots') {
      res.writeHead(200, { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : 'User-agent: *\nDisallow: /\n');
    }
    if (target === '') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { status: 'error', code: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      res.writeHead(200, { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP,
        'Content-Length': Buffer.byteLength(html) });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    // status/redeem: POST only. GET/HEAD/OPTIONS never touch link state.
    if (req.method !== 'POST') return json(405, { status: 'error', code: 'method_not_allowed' }, { Allow: 'POST' });
    let token;
    try { token = await readToken(req); }
    catch (error) { return json(error.status ?? 400, { status: 'error', code: error.code ?? 'invalid_request' }); }
    // Unknown and malformed tokens are indistinguishable; no row is ever listed.
    const hashValue = token ? tokenHash(token) : null;
    if (target === 'status') {
      const status = hashValue ? links.status(hashValue, now()) : { state: 'not_found' };
      return json(200, { status: 'ok', ...status });
    }
    if (!hashValue) return json(404, { status: 'error', code: 'link_not_found' });
    if (inFlight >= MAX_CONCURRENT) return json(503, { status: 'error', code: 'busy' }, { 'Retry-After': '5' });
    const claim = links.claim(hashValue, now());
    if (claim.outcome !== 'claimed') {
      if (claim.outcome === 'expired') { try { logStore.remove(claim.row.ref); } catch { /* Prune retries. */ } }
      const status = { not_found: 404, in_use: 409 }[claim.outcome] ?? 410;
      return json(status, { status: 'error', code: `link_${claim.outcome}` }, claim.outcome === 'in_use' ? { 'Retry-After': '30' } : {});
    }
    const { row } = claim;
    let bytes;
    try { bytes = logStore.read(row.ref); } catch { bytes = undefined; }
    if (bytes === undefined) {
      links.release(hashValue, now());
      return json(503, { status: 'error', code: 'logs_storage_unavailable' }, { 'Retry-After': '30' });
    }
    if (bytes === null || bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      links.unavailable(hashValue, now());
      logger.warn(JSON.stringify({ event: 'vortex_logs_link_unavailable', ref: row.ref }));
      return json(410, { status: 'error', code: 'link_unavailable' });
    }
    inFlight++;
    // Decide only when the socket accepted (or refused) every byte AND the
    // response closed. 'finish' alone is not enough: Node also emits it after
    // a client abort. A write callback without error means all bytes were handed
    // to the kernel/proxy; HTTP still cannot prove the client stored them, so
    // treat it as delivered and never serve the file again.
    let wrote = null;
    let closed = false;
    const settle = () => {
      if (wrote === null || !closed) return;
      inFlight--;
      try { record(); } catch { logger.warn(JSON.stringify({ event: 'vortex_logs_link_state_failed', ref: row.ref })); }
    };
    // A failure here leaves the row 'delivering' (never re-served while running);
    // the next start re-arms it.
    const record = () => {
      if (wrote) {
        links.finish(hashValue, now());
        if (graceMs === 0) { try { logStore.remove(row.ref); } catch { /* Prune deletes used files. */ } }
        logger.info?.(JSON.stringify({ event: 'vortex_logs_link_delivered', ref: row.ref, bytes: row.bytes }));
      } else if (links.release(hashValue, now())) {
        // Aborted before the last byte left: nothing complete was delivered.
        logger.warn(JSON.stringify({ event: 'vortex_logs_link_interrupted', ref: row.ref }));
      }
    };
    res.on('close', () => { closed = true; settle(); });
    res.setTimeout(60_000, () => res.destroy());
    res.writeHead(200, { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': bytes.length,
      'Content-Disposition': `attachment; filename="${row.ref}"`, 'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Vortex-Logs-Ref': row.ref, 'X-Vortex-Logs-SHA256': row.sha256 });
    res.write(bytes, (error) => { wrote = !error; settle(); });
    res.end();
  }
}

async function readToken(req) {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(type)) throw Object.assign(new Error(), { status: 415, code: 'unsupported_content_type' });
  if (Number(req.headers['content-length']) > MAX_FORM_BYTES) throw Object.assign(new Error(), { status: 413, code: 'request_too_large' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) throw Object.assign(new Error(), { status: 413, code: 'request_too_large' });
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  let token = form.get('token') ?? '';
  // Agents may paste the whole link: accept it, using only the fragment.
  const fragment = /#(?:.*&)?t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(token);
  if (fragment) token = fragment[1];
  token = token.trim();
  return TOKEN.test(token) ? token : null;
}

export function validPeerList(value) {
  const peers = value.split(',').map((peer) => peer.trim()).filter(Boolean);
  if (peers.some((peer) => !isIP(peer))) throw new Error('Invalid download peer');
  return peers;
}
