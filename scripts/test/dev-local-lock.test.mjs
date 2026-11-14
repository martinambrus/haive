import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const compose = readFileSync(new URL('../../docker-compose.dev.yml', import.meta.url), 'utf8');
const command = /command: >\n\s+sh -c "([\s\S]*?)"\n/.exec(compose)[1].replaceAll('$$', '$');

for (const exists of [true, false]) {
  test(`db-migrate returns local lock ownership only when the directory exists (${exists})`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'haive-dev-lock-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const app = join(root, 'app');
    const bin = join(root, 'bin');
    const log = join(root, 'chown.log');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    if (exists) mkdirSync(join(app, 'external-modules/.lock'), { recursive: true });
    mkdirSync(bin);
    for (const name of ['npm', 'corepack', 'pnpm'])
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'chown'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CHOWN_LOG"\n', {
      mode: 0o755,
    });
    const result = spawnSync('sh', ['-c', command.replaceAll('/app', app)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CHOWN_LOG: log },
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8');
    assert.ok(calls.includes(join(app, 'node_modules')));
    assert.equal(calls.includes(join(app, 'external-modules/.lock')), exists);
  });
}
