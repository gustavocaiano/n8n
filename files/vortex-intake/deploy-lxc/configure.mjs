// Read configuration as data, never source a file containing other service secrets.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { configFromEnv } from '../adapter/server.mjs';

const defaults = {
  VORTEX_INTAKE_PLANE_URL: 'https://plane.nforensic.site',
  VORTEX_INTAKE_PLANE_WORKSPACE: 'novaforensic',
  VORTEX_INTAKE_PLANE_PROJECT: '5f28cbf4-ad80-4914-90f3-ad09b2e21080',
  VORTEX_INTAKE_BUG_LABEL: '331c65f2-1c2e-4ab8-8fce-a5b92387192b',
  VORTEX_INTAKE_FEATURE_LABEL: '977bd461-ae12-409c-a029-9bb4f3dc1af9',
  VORTEX_INTAKE_STORAGE_ORIGINS: '',
  VORTEX_INTAKE_PLANE_PROJECT_IDENTIFIER: 'VORTEX',
  // Files WITHOUT a one-time link (stored before links, or with links disabled).
  VORTEX_INTAKE_LOGS_RETENTION_DAYS: '90',
  // One-time links: empty base = disabled (no public listener, notes as before).
  VORTEX_INTAKE_LOGS_LINK_BASE: '',
  VORTEX_INTAKE_LOGS_LINK_TTL_DAYS: '15',
  VORTEX_INTAKE_LOGS_DELIVERED_GRACE_HOURS: '0',
  VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST: '127.0.0.1',
  VORTEX_INTAKE_DOWNLOAD_PORT: '8087',
  VORTEX_INTAKE_DOWNLOAD_ALLOWED_PEERS: '',
};

export function prepareEnvironment(source, existing = {}, shared = {}) {
  const values = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    values[key] = existing[key] ?? source[key] ?? fallback;
  }
  // Always reuse the service key already configured for the active v1 workflow.
  values.VORTEX_INTAKE_PLANE_API_KEY = source.VORTEX_INTAKE_PLANE_API_KEY;
  const token = shared.VORTEX_INTAKE_TOKEN || source.VORTEX_INTAKE_TOKEN || randomBytes(32).toString('hex');
  if (shared.VORTEX_INTAKE_TOKEN && source.VORTEX_INTAKE_TOKEN && shared.VORTEX_INTAKE_TOKEN !== source.VORTEX_INTAKE_TOKEN) {
    throw new Error('Conflicting intake tokens; reconcile the existing configuration first');
  }
  values.VORTEX_INTAKE_LISTEN_HOST = '127.0.0.1';
  values.VORTEX_INTAKE_DATA_DIR = '/var/lib/vortex-intake';
  configFromEnv({ ...values, VORTEX_INTAKE_TOKEN: token });
  return { adapter: values, shared: { VORTEX_INTAKE_TOKEN: token } };
}

export function environmentFile(values) {
  return Object.entries(values).map(([key, value]) => {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid environment value');
    // systemd EnvironmentFile: no shell evaluation or variable interpolation.
    return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`;
  }).join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, sourcePath = '/opt/n8n.env', configDir = '/etc/vortex-intake'] = process.argv.slice(2);
    if (!['--check', '--apply'].includes(mode)) throw new Error('Expected --check or --apply');
    const read = (path) => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
    const prepared = prepareEnvironment(read(sourcePath), read(`${configDir}/adapter.env`), read(`${configDir}/token.env`));
    for (const [name, values] of [['adapter', prepared.adapter], ['token', prepared.shared]]) {
      const text = environmentFile(values);
      if (mode === '--apply') {
        const path = `${configDir}/${name}.env`;
        writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      }
    }
    console.log(`Intake configuration ${mode === '--check' ? 'valid' : 'written'} (secret values omitted)`);
  } catch {
    console.error('Intake configuration failed: check the existing Plane key, token consistency and adapter settings');
    process.exitCode = 1;
  }
}
