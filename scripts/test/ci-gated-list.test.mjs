import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// A file that skips unless a *_URL env var is set, and guards the database it is then given.
const GATE = /\b(?:describe|it|test)\.skipIf\(/;
const URL_ENV = /process\.env\.[A-Z0-9_]+_URL\b/;
const DB_GUARD = /pathname\.startsWith\(|(?:CREATE|DROP) DATABASE/;

const gatedFiles = readdirSync(join(root, 'packages'))
  .flatMap((pkg) => {
    const dir = join(root, 'packages', pkg, 'test');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true })
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => `packages/${pkg}/test/${file}`);
  })
  .filter((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return GATE.test(text) && URL_ENV.test(text) && DB_GUARD.test(text);
  })
  .sort();

const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const rows = /<<'GATED'\n([\s\S]+?)\n[ \t]*GATED\n/.exec(ci)?.[1];
assert.ok(rows, "ci.yml has no <<'GATED' list");
const listedFiles = rows
  .split('\n')
  .map((row) => row.trim().split(/\s+/))
  .map(([pkg, file]) => `packages/${pkg}/${file}`)
  .sort();

describe('the Postgres-gated list in ci.yml', () => {
  it('lists every file exactly once', () => {
    assert.equal(new Set(listedFiles).size, listedFiles.length, 'duplicate GATED test row');
  });

  it('has a row for every gated test file', () => {
    assert.deepEqual(
      gatedFiles.filter((file) => !listedFiles.includes(file)),
      [],
      'gated test files with no row in the GATED list of ci.yml, which CI would skip green',
    );
  });

  it('has no row for a file that is not a gated test file', () => {
    assert.deepEqual(
      listedFiles.filter((file) => !gatedFiles.includes(file)),
      [],
      'rows in the GATED list of ci.yml that name no gated test file',
    );
  });
});
