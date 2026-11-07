import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { prepareEnvironment, environmentFile } from '../deploy-lxc/configure.mjs';
import { configFromEnv } from '../adapter/server.mjs';

const source = { VORTEX_INTAKE_PLANE_API_KEY: 'plane-existing-key', OTHER_SERVICE_TOKEN: 'unrelated-secret' };
test('LXC configuration reuses the Plane key without copying unrelated service secrets', () => {
  const config = prepareEnvironment(source);
  assert.equal(config.adapter.VORTEX_INTAKE_PLANE_API_KEY, source.VORTEX_INTAKE_PLANE_API_KEY);
  assert.equal(config.adapter.OTHER_SERVICE_TOKEN, undefined);
  assert.equal(config.adapter.VORTEX_INTAKE_TOKEN, undefined);
  assert.equal(config.adapter.VORTEX_INTAKE_LISTEN_HOST, '127.0.0.1');
  assert.equal(config.adapter.VORTEX_INTAKE_DATA_DIR, '/var/lib/vortex-intake');
  assert.match(config.shared.VORTEX_INTAKE_TOKEN, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseEnv(environmentFile(config.adapter)), config.adapter);
});
test('reinstall preserves token and operator settings, while refreshing the existing Plane key', () => {
  const first = prepareEnvironment(source);
  const existing = { ...first.adapter, VORTEX_INTAKE_LOGS_RETENTION_DAYS: '30', VORTEX_INTAKE_STORAGE_ORIGINS: 'https://storage.example.com' };
  const second = prepareEnvironment({ ...source, VORTEX_INTAKE_PLANE_API_KEY: 'rotated-key' }, existing, first.shared);
  assert.deepEqual(second.shared, first.shared);
  assert.equal(second.adapter.VORTEX_INTAKE_PLANE_API_KEY, 'rotated-key');
  assert.equal(second.adapter.VORTEX_INTAKE_LOGS_RETENTION_DAYS, '30');
  assert.equal(second.adapter.VORTEX_INTAKE_STORAGE_ORIGINS, 'https://storage.example.com');
});
test('LXC config refuses missing keys, conflicting tokens and environment line injection', () => {
  assert.throws(() => prepareEnvironment({}));
  assert.throws(() => prepareEnvironment({ ...source, VORTEX_INTAKE_TOKEN: 'one' }, {}, { VORTEX_INTAKE_TOKEN: 'two' }), /Conflicting/);
  assert.throws(() => environmentFile({ VORTEX_INTAKE_TOKEN: 'token\nOTHER=bad' }), /Invalid/);
  assert.equal(prepareEnvironment({ ...source, VORTEX_INTAKE_TOKEN: 'keep-existing' }).shared.VORTEX_INTAKE_TOKEN, 'keep-existing');
});
test('native listener defaults to loopback; Docker must explicitly select its private interface', () => {
  const prepared = prepareEnvironment(source);
  const env = { ...prepared.adapter, ...prepared.shared };
  delete env.VORTEX_INTAKE_LISTEN_HOST;
  assert.equal(configFromEnv(env).listenHost, '127.0.0.1');
  assert.equal(configFromEnv({ ...env, VORTEX_INTAKE_LISTEN_HOST: '0.0.0.0' }).listenHost, '0.0.0.0');
  assert.throws(() => configFromEnv({ ...env, VORTEX_INTAKE_LISTEN_HOST: 'public.example.com' }), /Invalid intake listen host/);
});
