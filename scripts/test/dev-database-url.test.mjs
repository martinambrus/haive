import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const helper = new URL('../lib/dev-database-url.mjs', import.meta.url).href;
function resolve(t, text, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dpc-url-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  writeFileSync(file, text);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('POSTGRES_') || key === 'DATABASE_URL') delete env[key];
  }
  return spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { devDatabaseUrl } from ${JSON.stringify(helper)}; process.stdout.write(devDatabaseUrl(${JSON.stringify(file)}));`,
    ],
    {
      encoding: 'utf8',
      env: { ...env, ...overrides },
    },
  );
}

test('host tools derive URL-encoded credentials from the install .env', (t) => {
  const out = resolve(
    t,
    'POSTGRES_USER=custom\nPOSTGRES_PASSWORD="private:p@ss"\nPOSTGRES_DB=customdb\nPOSTGRES_HOST=postgres\n',
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'postgres://custom:private%3Ap%40ss@localhost:5432/customdb');
});

test('an explicit environment URL keeps CI credentials and host unchanged', (t) => {
  const url = 'postgres://ci:ci-password@ci-store:5555/ci';
  const out = resolve(t, 'POSTGRES_PASSWORD=file-password\n', { DATABASE_URL: url });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, url);
});

test('an install URL maps only the internal compose hostname for host consumers', (t) => {
  const out = resolve(t, 'DATABASE_URL=postgres://custom:private@postgres:5432/customdb\n');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'postgres://custom:private@localhost:5432/customdb');
});

test('a missing password fails with setup instructions instead of a public fallback', (t) => {
  const out = resolve(t, 'POSTGRES_USER=haive\n');
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /generate .env credentials/);
});

test('schema-parity keeps explicit CI PG_* settings and ignores Playwright overrides', () => {
  const out = spawnSync(
    'node',
    [new URL('../lib/dev-database-url.mjs', import.meta.url).pathname, 'parity_probe'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://base:base@localhost:5432/base',
        PLAYWRIGHT_DATABASE_URL: 'postgres://wrong:wrong@wrong:5555/wrong',
        PG_USER: 'ci',
        PG_PASSWORD: 'ci:password',
        PG_HOST: 'ci-store',
        PG_PORT: '5544',
      },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'postgres://ci:ci%3Apassword@ci-store:5544/parity_probe');
});
