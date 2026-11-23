import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { logSignatures } from '../adapter/signature.mjs';
import { logsNote, normalize } from '../adapter/contract.mjs';
import { setup, logsFile, withLogs } from './helpers.mjs';

const HEADER = '# Vortex 3.1.0 (https://nuc.invalid) — logs desde 2026-11-20T12:00:00+00:00 até 2026-11-22T12:00:00+00:00\n';
const SECRET = 'hunter2-SECRET-message-for-ana@example.com';
const sigOf = (cls, path) => createHash('sha256').update(`${cls}|${path}`).digest('hex').slice(0, 12);

function laravel(ts, cls, { message = 'boom', origin = '/var/www/html/app/Foo/Bar.php:123', frames = [], level = 'ERROR' } = {}) {
  const trace = ['#0 /var/www/html/vendor/laravel/framework/src/Illuminate/Foo.php(10): Illuminate\\Foo->bar()',
    ...frames.map((f, i) => `#${i + 1} ${f}: App\\X->y()`), `#${frames.length + 1} {main}`].join('\n');
  return `[${ts}] production.${level}: ${message} {"exception":"[object] (${cls.replace(/\\/g, '\\\\')}(code: 0): ${message} at ${origin})\n[stacktrace]\n${trace}\n"} \n`;
}
const graph = (ts, cls, file, line) => `[${ts}] production.INFO: engine_query_failed {"version":"3.1.0","exception_type":"${cls.replace(/\\/g, '\\\\')}","exception_file":"${file}","exception_line":${line},"engine_code":null}\n`;

test('signature: Laravel exception uses the first application frame', () => {
  const text = HEADER + laravel('2026-11-21 12:00:00', 'App\\Exceptions\\Boom', { message: SECRET, frames: ['/var/www/html/app/Http/Controllers/FooController.php(45)'] });
  assert.deepEqual(logSignatures(text), [{ sig: sigOf('App\\Exceptions\\Boom', 'app/Http/Controllers/FooController.php'),
    cls: 'App\\Exceptions\\Boom', frame: 'app/Http/Controllers/FooController.php:45', count: 1 }]);
});

test('signature: without an application frame, falls back to an app origin, then to vendor', () => {
  const app = logSignatures(HEADER + laravel('2026-11-21 12:00:00', '\\RuntimeException'));
  assert.deepEqual(app.map(({ cls, frame }) => [cls, frame]), [['RuntimeException', 'app/Foo/Bar.php:123']]);
  const vendor = logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'Illuminate\\Database\\QueryException',
    { origin: '/var/www/html/vendor/laravel/framework/src/Illuminate/Database/Connection.php:822' }));
  assert.equal(vendor.length, 1);
  assert.equal(vendor[0].frame, 'vendor/laravel/framework/src/Illuminate/Database/Connection.php:822');
  assert.equal(vendor[0].sig, sigOf('Illuminate\\Database\\QueryException', 'vendor/laravel/framework/src/Illuminate/Database/Connection.php'));
  // A config/ directory inside a dependency is not an application path.
  const nested = logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'Foo', { origin: '/srv/vendor/x/config/y.php:5' }));
  assert.equal(nested[0].frame, 'vendor/x/config/y.php:5');
  assert.deepEqual(logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'Foo', { origin: '/usr/share/php/Z.php:5' })), []);
});

test('signature: evidence-graph context fields are supported and the sig ignores the line', () => {
  const a = logSignatures(HEADER + '# Diagnóstico do grafo\n' + graph('2026-11-21 10:00:00', 'App\\Support\\EvidenceGraph\\Engine\\EngineException', 'app/Support/EvidenceGraph/Engine/Q.php', 353));
  const b = logSignatures(graph('2026-11-21 10:00:00', 'App\\Support\\EvidenceGraph\\Engine\\EngineException', 'app/Support/EvidenceGraph/Engine/Q.php', 360));
  assert.equal(a[0].frame, 'app/Support/EvidenceGraph/Engine/Q.php:353');
  assert.equal(a[0].sig, b[0].sig); assert.notEqual(a[0].frame, b[0].frame);
});

test('signature: message text and user data never appear in the output', () => {
  const text = HEADER + laravel('2026-11-21 12:00:00', 'App\\Exceptions\\Boom', { message: SECRET, frames: ['/var/www/html/app/A.php(1)'] }) +
    laravel('2026-11-21 12:01:00', 'Illuminate\\Database\\QueryException', { message: `SQL: insert into t values ('${SECRET}')`, origin: '/var/www/html/vendor/a/b.php:9' });
  const out = JSON.stringify(logSignatures(text));
  assert.ok(logSignatures(text).length === 2);
  assert.ok(!out.includes('SECRET') && !out.includes('hunter2') && !out.includes('example.com'), out);
  // A class or path carrying anything but identifier characters is skipped entirely.
  assert.deepEqual(logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'Bad Class', { origin: '/var/www/html/app/A.php:1' })), []);
  assert.deepEqual(logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'Foo', { origin: '/var/www/html/app/A B.php:1' })), []);
  assert.deepEqual(logSignatures(HEADER + laravel('2026-11-21 12:00:00', 'A'.repeat(201))), []);
});

test('signature: only error levels count for Laravel entries; entries are grouped, ordered and capped at 3', () => {
  const at = (n) => `/var/www/html/app/F${n}.php:1`;
  const text = HEADER +
    laravel('2026-11-21 08:00:00', 'E1', { origin: at(1) }) +
    laravel('2026-11-21 09:00:00', 'E2', { origin: at(2) }) +
    laravel('2026-11-21 10:00:00', 'E1', { origin: at(1) }) +
    laravel('2026-11-21 11:00:00', 'E3', { origin: at(3), level: 'CRITICAL' }) +
    laravel('2026-11-21 11:30:00', 'Warn', { origin: at(9), level: 'WARNING' }) +
    laravel('2026-11-21 12:00:00', 'E4', { origin: at(4), level: 'EMERGENCY' }) +
    laravel('2026-11-21 12:00:00', 'E5', { origin: at(5), level: 'ALERT' }) +
    laravel('2026-11-21 06:00:00', 'E1', { origin: at(1) }) +
    '# Diagnóstico do grafo\n' + graph('2026-11-21 03:00:00', 'G', 'app/G.php', 7);
  // Newest first; the 12:00:00 tie goes to the later entry (E5); E1 (x3, last seen 10:00) falls out of the top 3.
  assert.deepEqual(logSignatures(text).map((s) => [s.cls, s.count]), [['E5', 1], ['E4', 1], ['E3', 1]]);
  const small = HEADER + laravel('2026-11-21 08:00:00', 'E1', { origin: at(1) }) + laravel('2026-11-21 09:00:00', 'E2', { origin: at(2) }) +
    laravel('2026-11-21 10:00:00', 'E1', { origin: at(1) });
  assert.deepEqual(logSignatures(small).map((s) => [s.cls, s.count]), [['E1', 2], ['E2', 1]]);
});

test('signature: malformed or empty input returns [] and never throws', () => {
  for (const bad of [undefined, null, 42, {}, '', 'plain text', HEADER, '[2026-11-21 12:00:00] production.ERROR: x {"exception":"[object] (',
    '[2026-11-21 12:00:00] production.ERROR: x {"exception":"[object] (Foo(code: 0): m at )\n[stacktrace]\n#0 ',
    '[2026-11-21 12:00:00] x.INFO: y {"exception_type":"Foo","exception_file":"app/A.php"}', '\x00\xff'.repeat(1000)]) {
    assert.deepEqual(logSignatures(bad), []);
  }
});

test('signature: deterministic for the same bytes', () => {
  const text = HEADER + laravel('2026-11-21 12:00:00', 'Foo', { frames: ['/var/www/html/app/A.php(1)'] });
  assert.deepEqual(logSignatures(text), logSignatures(text));
});

test('signature note: HTML lists sig, class, frame and ×count, escaped; nothing without signatures', () => {
  const input = normalize(withLogs(), null, logsFile());
  const ref = 'VORTEX-14_x.txt';
  assert.equal(logsNote(input, ref), logsNote(input, ref, null, []));
  assert.ok(!logsNote(input, ref).includes('Assinatura'));
  const sigs = [{ sig: '0123456789ab', cls: 'Some\\Class', frame: 'app/Foo/Bar.php:123', count: 3 },
    { sig: 'ba9876543210', cls: 'Other<b>', frame: 'vendor/x/Y.php:1', count: 1 }];
  const note = logsNote(input, ref, null, sigs);
  assert.ok(note.endsWith('<p><strong>Assinatura técnica:</strong></p><ul>' +
    '<li><code>sig:0123456789ab</code> <code>Some\\Class</code> em <code>app/Foo/Bar.php:123</code> ×3</li>' +
    '<li><code>sig:ba9876543210</code> <code>Other&lt;b&gt;</code> em <code>vendor/x/Y.php:1</code></li></ul>'), note);
  const link = { url: `https://logs.invalid/vortex-logs/#t=${'A'.repeat(43)}`, expiresAt: Date.now() };
  const withLink = logsNote(input, ref, link, sigs);
  assert.ok(withLink.indexOf('Assinatura') < withLink.indexOf('Obter logs'), 'signature precedes the link paragraph');
});

test('signature: Plane description carries the signature and a replay produces the identical description', async (t) => {
  const text = HEADER + laravel('2026-11-21 12:00:00', 'App\\Exceptions\\Boom', { message: SECRET, frames: ['/var/www/html/app/Http/A.php(45)'] });
  const file = logsFile(text);
  const ctx = setup(t);
  await ctx.intake.submit(withLogs(file), null, file);
  const html = ctx.plane.issues[0].description_html;
  assert.match(html, /<p><strong>Assinatura técnica:<\/strong><\/p><ul><li><code>sig:[0-9a-f]{12}<\/code> <code>App\\Exceptions\\Boom<\/code> em <code>app\/Http\/A\.php:45<\/code><\/li><\/ul>$/);
  assert.ok(!html.includes('SECRET') && !html.includes('hunter2'));
  ctx.restart();
  await ctx.intake.submit({ ...withLogs(file), reported_at: 'later' }, null, file);
  const replay = ctx.plane.issues[0].description_html;
  assert.equal(replay, html);
  // Same bytes through a fresh request must also yield the same note after a failed first attempt.
  const again = setup(t);
  again.plane.fail('updateDescription', Object.assign(new Error('x'), { upstreamStatus: 503 }));
  await assert.rejects(again.intake.submit(withLogs(file), null, file));
  again.restart();
  await again.intake.submit(withLogs(file), null, file);
  assert.equal(again.plane.issues[0].description_html, html);
});

test('signature: logs without exceptions add no signature to the note', async (t) => {
  const ctx = setup(t);
  const file = logsFile('# Vortex\n[2026-11-21 12:00:00] production.ERROR: x\n');
  const result = await ctx.intake.submit(withLogs(file), null, file);
  assert.equal(result.status, 200);
  assert.ok(!ctx.plane.issues[0].description_html.includes('Assinatura'));
});
