import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';

function fixture(t, env) {
  const root = mkdtempSync(join(tmpdir(), 'dpc-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../dev.sh', import.meta.url), join(root, 'scripts/dev.sh'));
  if (env !== undefined) writeFileSync(join(root, '.env'), env);
  writeFileSync(
    join(root, 'docker'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$DPC_LOG"
case " $* " in
  *' exec -T postgres '*) cat >> "$DPC_SQL"; if [ "$DPC_FAIL" = 1 ]; then cat "$DPC_SQL" >&2; exit 1; fi ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (args = ['up'], extra = {}) =>
    spawnSync('bash', [join(root, 'scripts/dev.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HAIVE_GPU: 'cpu',
        PATH: `${root}:${process.env.PATH}`,
        DPC_LOG: join(root, 'calls'),
        DPC_SQL: join(root, 'sql'),
        ...extra,
      },
    });
  return {
    root,
    run,
    env: () => readFileSync(join(root, '.env'), 'utf8'),
    calls: () => readFileSync(join(root, 'calls'), 'utf8'),
    sql: () => readFileSync(join(root, 'sql'), 'utf8'),
  };
}

for (const args of [
  ['up'],
  ['run'],
  ['restart', 'worker'],
  ['rebuild'],
  ['rebuild', 'api'],
  ['reset'],
]) {
  test(`${args.join(' ')} rotates the default, syncs via stdin before starting dependants`, (t) => {
    const f = fixture(
      t,
      '# keep me\nPOSTGRES_PASSWORD=haive_dev_password # old\nDATABASE_URL=postgres://haive:haive_dev_password@postgres:5432/haive\nOTHER=keep\n',
    );
    const out = f.run(args);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const env = parseEnv(f.env());
    assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
    assert.match(env.MAILPIT_UI_PASSWORD, /^[a-f0-9]{48}$/);
    assert.equal(env.DATABASE_URL, `postgres://haive:${env.POSTGRES_PASSWORD}@postgres:5432/haive`);
    assert.ok(f.env().includes('# keep me\n'));
    assert.ok(f.env().includes(' # old\n'));
    assert.ok(f.env().includes('OTHER=keep\n'));
    for (const password of [env.POSTGRES_PASSWORD, env.MAILPIT_UI_PASSWORD]) {
      assert.ok(!(out.stdout + out.stderr + f.calls()).includes(password));
    }
    assert.ok(f.sql().includes(env.POSTGRES_PASSWORD));
    assert.match(f.sql(), /ALTER ROLE/);
    const calls = f.calls().trim().split('\n');
    const healthy = calls.findIndex((c) => c.includes('up -d --wait') && c.endsWith('postgres'));
    const alter = calls.findIndex((c) => c.includes('exec -T postgres'));
    const start = calls.findLastIndex((c) => c.includes(' up -d'));
    assert.ok(healthy >= 0 && healthy < alter && alter < start, f.calls());
    if (args.length > 1) {
      for (const svc of ['api', 'worker', 'web', 'db-migrate', 'mailpit'])
        assert.ok(calls[start].split(' ').includes(svc));
    } else {
      assert.match(calls[start], /up -d$/); // unselected up starts every compose service
    }
  });
}

test('missing .env is created private and a second run changes nothing', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(statSync(join(f.root, '.env')).mode & 0o777, 0o600);
  const first = f.env();
  assert.ok(parseEnv(first).POSTGRES_PASSWORD);
  assert.equal(f.run().status, 0);
  assert.equal(f.env(), first);
});

test('missing keys are appended and quoted non-default credentials are kept', (t) => {
  const f = fixture(t, "# comment\nPOSTGRES_PASSWORD='private-password'\nUNRELATED=yes\n");
  assert.equal(f.run().status, 0);
  assert.ok(f.env().startsWith("# comment\nPOSTGRES_PASSWORD='private-password'\nUNRELATED=yes\n"));
  assert.ok(parseEnv(f.env()).MAILPIT_UI_PASSWORD);
  assert.ok(f.sql().includes('private-password'));
});

test('custom credentials are unchanged and shell overrides cannot desynchronise compose', (t) => {
  const text = 'POSTGRES_PASSWORD=private-password\nMAILPIT_UI_PASSWORD=private-mail\n';
  const f = fixture(t, text);
  const out = f.run(['up'], { POSTGRES_PASSWORD: 'wrong-shell-password' });
  assert.equal(out.status, 0);
  assert.equal(f.env(), text);
  assert.ok(f.sql().includes('private-password'));
  assert.ok(!(out.stdout + out.stderr).includes('private-password'));
});

test('ALTER failure stops the boot, hides SQL errors and explains recovery', (t) => {
  const f = fixture(t, 'POSTGRES_PASSWORD=private-password\nMAILPIT_UI_PASSWORD=private-mail\n');
  const out = f.run(['up'], { DPC_FAIL: '1' });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout + out.stderr, /password.*sync|sync.*password/i);
  assert.match(out.stdout + out.stderr, /rerun|re-run|retry/i);
  assert.ok(!(out.stdout + out.stderr).includes('private-password'));
  assert.equal(
    f
      .calls()
      .split('\n')
      .filter((c) => c.includes(' up -d')).length,
    1,
  );
});

test('dev Mailpit HTTP auth is driven by the private password, SMTP stays internal', () => {
  const compose = readFileSync(new URL('../../docker-compose.dev.yml', import.meta.url), 'utf8');
  const mailpit = compose.split('\n  mailpit:\n')[1].split('\n  db-migrate:')[0];
  assert.match(mailpit, /MP_UI_AUTH:.*MAILPIT_UI_PASSWORD:\+haive:.*MAILPIT_UI_PASSWORD/);
  assert.ok(!mailpit.includes('1025:1025'));
  assert.ok(!mailpit.includes('MP_SMTP_AUTH'));
});

for (const command of ['libs', 'migrate']) {
  test(`${command} syncs before its one-shot can start database dependants`, (t) => {
    const f = fixture(t, 'POSTGRES_PASSWORD=private-password\nMAILPIT_UI_PASSWORD=private-mail\n');
    const out = f.run([command]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const calls = f.calls().trim().split('\n');
    assert.ok(
      calls.findIndex((c) => c.includes('exec -T postgres')) <
        calls.findIndex((c) => c.includes(' run --rm')),
    );
  });
}

test('a changed .env is reconciled on the next partial up even without fresh generation', (t) => {
  const f = fixture(t, 'POSTGRES_PASSWORD=private-password\nMAILPIT_UI_PASSWORD=private-mail\n');
  const out = f.run(['up', 'worker']);
  assert.equal(out.status, 0);
  assert.ok(f.sql().includes('private-password'));
  assert.match(f.calls().trim().split('\n').at(-1), /api worker web db-migrate mailpit$/);
});

test('quoted role passwords are SQL literals and errors cannot print them', (t) => {
  const f = fixture(t, `POSTGRES_PASSWORD="private'password"\nMAILPIT_UI_PASSWORD=private-mail\n`);
  const out = f.run();
  assert.equal(out.status, 0);
  assert.ok(f.sql().includes("private''password"));
});

test('an unselected restart still brings up the whole stack', (t) => {
  const f = fixture(t, 'POSTGRES_PASSWORD=private-password\nMAILPIT_UI_PASSWORD=private-mail\n');
  const out = f.run(['restart']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(f.calls().trim().split('\n').at(-1), /up -d --force-recreate$/);
});

test('blank credentials with inline comments rotate while retaining those comments', (t) => {
  const f = fixture(
    t,
    'POSTGRES_PASSWORD= # database comment\nMAILPIT_UI_PASSWORD= # mail comment\n',
  );
  const out = f.run();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const env = parseEnv(f.env());
  assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
  assert.match(env.MAILPIT_UI_PASSWORD, /^[a-f0-9]{48}$/);
  assert.ok(f.env().includes(' # database comment'));
  assert.ok(f.env().includes(' # mail comment'));
});
