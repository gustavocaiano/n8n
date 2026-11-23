import { createHash } from 'node:crypto';

// Technical signature of a Vortex log snapshot: exception class + source path + count.
// Deliberately free of log messages and user data, so a triage bot can match duplicates.
// Pure, deterministic and never throws (any problem yields []).

const MAX_SIGNATURES = 3;
const MAX_CLASS = 200;
const MAX_FRAME = 300;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_\\]*$/;
const SAFE_PATH = /^[A-Za-z0-9_.@+\-/]+$/;
const APP_SEGMENT = /(?:^|\/)(?:app|resources|routes|database|config|bootstrap)\//;
const VENDOR_SEGMENT = /(?:^|\/)vendor\//;
const HEADER = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[^\]]*\]\s+[\w-]+\.([A-Z]+):/;
const ERROR_LEVELS = new Set(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);
const GRAPH_SECTION = /^# Diagnóstico do grafo\s*$/;

// Application-relative path, or vendor/... for dependencies; null when neither.
function relativePath(path) {
  const clean = path.replace(/\\\//g, '/');
  const vendor = clean.search(VENDOR_SEGMENT);
  const app = clean.search(APP_SEGMENT);
  const cut = (index) => clean.slice(index).replace(/^\//, '');
  if (app >= 0 && (vendor < 0 || app < vendor)) return { path: cut(app), vendor: false };
  if (vendor >= 0) return { path: cut(vendor), vendor: true };
  return null;
}

function usable(path, line) {
  const frame = `${path}:${line}`;
  return SAFE_PATH.test(path) && frame.length <= MAX_FRAME && Number.isSafeInteger(Number(line)) ? { path, frame } : null;
}

function className(raw) {
  const cls = raw.replace(/\\\\/g, '\\').replace(/^\\+/, '');
  return cls.length <= MAX_CLASS && CLASS_NAME.test(cls) ? cls : null;
}

// Laravel monolog: {"exception":"[object] (Class(code: 0): message at /abs/File.php:12)\n[stacktrace]\n#0 /abs/f.php(3): ..."}
function laravelException(entry) {
  const head = /\[object\] \(([^\s(]+)\(code: /.exec(entry);
  if (!head) return null;
  const cls = className(head[1]);
  if (!cls) return null;
  const stackAt = entry.indexOf('\n[stacktrace]', head.index);
  const span = stackAt < 0 ? entry.slice(head.index) : entry.slice(head.index, stackAt);
  let origin = null;
  for (const m of span.matchAll(/ at (\S+):(\d+)\)/g)) origin = m;
  let first = null;
  if (stackAt >= 0) {
    let trace = entry.slice(stackAt);
    const previous = trace.indexOf('[previous exception]');
    if (previous >= 0) trace = trace.slice(0, previous);
    for (const m of trace.matchAll(/^#\d+ (\S+?)\((\d+)\): /gm)) {
      const rel = relativePath(m[1]);
      if (rel && !rel.vendor) { first = usable(rel.path, m[2]); if (first) break; }
    }
  }
  return { cls, first, origin: origin && { file: origin[1], line: origin[2] } };
}

// Evidence-graph diagnostics: context fields exception_type / exception_file / exception_line.
function graphException(headerLine) {
  const type = /"exception_type":"((?:[^"\\]|\\.)*)"/.exec(headerLine);
  const file = /"exception_file":"((?:[^"\\]|\\.)*)"/.exec(headerLine);
  const line = /"exception_line":(\d+)/.exec(headerLine);
  if (!type || !file || !line) return null;
  const cls = className(type[1]);
  return cls ? { cls, first: null, origin: { file: file[1], line: line[1] } } : null;
}

function frameOf(found) {
  if (found.first) return found.first;
  if (!found.origin) return null;
  const rel = relativePath(found.origin.file);
  return rel ? usable(rel.path, found.origin.line) : null;
}

function entries(text) {
  const list = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      current = { ts: `${header[1]} ${header[2]}`, level: header[3], head: line, lines: [line] };
      list.push(current);
    } else if (GRAPH_SECTION.test(line) || line.startsWith('# Vortex ')) current = null;
    else if (current) current.lines.push(line);
  }
  return list;
}

export function logSignatures(text) {
  try {
    if (typeof text !== 'string' || text === '') return [];
    const groups = new Map();
    entries(text).forEach((entry, position) => {
      const found = graphException(entry.head) ?? (ERROR_LEVELS.has(entry.level) ? laravelException(entry.lines.join('\n')) : null);
      const frame = found && frameOf(found);
      if (!frame) return;
      const sig = createHash('sha256').update(`${found.cls}|${frame.path}`).digest('hex').slice(0, 12);
      const group = groups.get(sig) ?? { sig, count: 0 };
      groups.set(sig, group);
      group.count += 1;
      // Entries within a channel run oldest to newest: later (timestamp, position) wins.
      if (!group.ts || entry.ts >= group.ts) Object.assign(group, { ts: entry.ts, position, cls: found.cls, frame: frame.frame });
    });
    return [...groups.values()]
      .sort((a, b) => (a.ts === b.ts ? b.position - a.position : a.ts < b.ts ? 1 : -1))
      .slice(0, MAX_SIGNATURES)
      .map(({ sig, cls, frame, count }) => ({ sig, cls, frame, count }));
  } catch {
    return [];
  }
}
