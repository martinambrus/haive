import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';

// Every password fixture is generated, never written out: secret scanners flag a literal value
// beside a password key or in a URL's userinfo, however short. `inner` places the character a
// case needs (a quote, `$`, `#`, `:`) between two random halves.
const secret = (inner = '') =>
  `${randomBytes(6).toString('hex')}${inner}${randomBytes(6).toString('hex')}`;
const PG = secret();
const MAIL = secret();
const CREDS = `POSTGRES_PASSWORD=${PG}\nMAILPIT_UI_PASSWORD=${MAIL}\n`;

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
  *' ps --services '*) printf '%b' "\${DPC_RUNNING:-}" ;;
  *' --wait '*) ;;
  *' up -d '*) if [ "$DPC_UP_FAIL" = 1 ]; then exit 1; fi ;;
esac
`,
    { mode: 0o755 },
  );
  const envFor = (extra = {}) => ({
    ...process.env,
    HAIVE_GPU: 'cpu',
    PATH: `${root}:${process.env.PATH}`,
    DPC_LOG: join(root, 'calls'),
    DPC_SQL: join(root, 'sql'),
    ...extra,
  });
  const run = (args = ['up'], extra = {}) =>
    spawnSync('bash', [join(root, 'scripts/dev.sh'), ...args], {
      encoding: 'utf8',
      env: envFor(extra),
    });
  return {
    root,
    run,
    envFor,
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
    chmodSync(join(f.root, '.env'), 0o644);
    const out = f.run(args);
    assert.equal(statSync(join(f.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(f.root).filter((n) => n.startsWith('.env.')),
      [],
    );
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
      // Only the named service is started; nothing else was running to reconcile.
      assert.match(calls[start], new RegExp(` up -d( --force-recreate)? ${args[1]}$`));
    } else {
      assert.match(calls[start], /up -d$/); // unselected up starts every compose service
    }
  });
}

test('two commands started together sync the one password .env ends with', async (t) => {
  const f = fixture(t, 'POSTGRES_PASSWORD=haive_dev_password\n');
  // A slow generator widens the window between reading .env and replacing it.
  writeFileSync(join(f.root, 'od'), '#!/bin/bash\nsleep 0.3\nexec /usr/bin/od "$@"\n', {
    mode: 0o755,
  });
  const start = (args) =>
    new Promise((resolve) => {
      const child = spawn('bash', [join(f.root, 'scripts/dev.sh'), ...args], {
        env: f.envFor(),
        stdio: 'ignore',
      });
      child.on('close', resolve);
    });
  assert.deepEqual(await Promise.all([start(['up']), start(['libs'])]), [0, 0]);
  const { POSTGRES_PASSWORD } = parseEnv(f.env());
  assert.match(POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
  const literals = [...f.sql().matchAll(/E'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(literals, [POSTGRES_PASSWORD, POSTGRES_PASSWORD]);
});

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
  const text = `# comment\nPOSTGRES_PASSWORD='${PG}'\nUNRELATED=yes\n`;
  const f = fixture(t, text);
  assert.equal(f.run().status, 0);
  assert.ok(f.env().startsWith(text));
  assert.ok(parseEnv(f.env()).MAILPIT_UI_PASSWORD);
  assert.ok(f.sql().includes(PG));
});

test('custom credentials are unchanged and shell overrides cannot desynchronise compose', (t) => {
  const text = CREDS;
  const f = fixture(t, text);
  const out = f.run(['up'], { POSTGRES_PASSWORD: secret() });
  assert.equal(out.status, 0);
  assert.equal(f.env(), text);
  assert.ok(f.sql().includes(PG));
  assert.ok(!(out.stdout + out.stderr).includes(PG));
});

test('ALTER failure stops the boot, hides SQL errors and explains recovery', (t) => {
  const f = fixture(t, CREDS);
  const out = f.run(['up'], { DPC_FAIL: '1' });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout + out.stderr, /password.*sync|sync.*password/i);
  assert.match(out.stdout + out.stderr, /rerun|re-run|retry/i);
  assert.ok(!(out.stdout + out.stderr).includes(PG));
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
    const f = fixture(t, CREDS);
    const out = f.run([command]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const calls = f.calls().trim().split('\n');
    assert.ok(
      calls.findIndex((c) => c.includes('exec -T postgres')) <
        calls.findIndex((c) => c.includes(' run --rm')),
    );
    // A stopped stack stays stopped: the sync starts no app service.
    assert.ok(!calls.some((c) => / up -d(?! --wait)/.test(c)), f.calls());
  });
}

test('libs reconciles only running app services, without forcing a recreate', (t) => {
  const f = fixture(t, CREDS);
  const out = f.run(['libs'], { DPC_RUNNING: 'postgres\\nworker\\nollama\\nweb\\n' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const ups = f
    .calls()
    .split('\n')
    .filter((c) => / up -d(?! --wait)/.test(c));
  assert.deepEqual(
    ups.map((c) => c.split(' up ')[1]),
    ['-d --no-deps worker web'],
  );
  // A crash-looping service may be the one still holding the old password.
  assert.match(f.calls(), /ps --services --status running --status restarting/);
});

test('restart of one service never force-recreates the other running services', (t) => {
  const f = fixture(t, CREDS);
  const out = f.run(['restart', 'api'], { DPC_RUNNING: 'api\\nworker\\n' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const ups = f
    .calls()
    .split('\n')
    .filter((c) => / up -d(?! --wait)/.test(c));
  assert.deepEqual(
    ups.map((c) => c.split(' up ')[1]),
    ['-d --force-recreate api', '-d --no-deps api worker'],
  );
});

test('a failed start after the sync says how to finish it', (t) => {
  const f = fixture(t, CREDS);
  const out = f.run(['up'], { DPC_UP_FAIL: '1' });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout + out.stderr, /re-run `pnpm docker up`/);
});

test('a changed .env is reconciled on the next partial up even without fresh generation', (t) => {
  const f = fixture(t, CREDS);
  const out = f.run(['up', 'worker'], { DPC_RUNNING: 'api\\nworker\\n' });
  assert.equal(out.status, 0);
  assert.ok(f.sql().includes(PG));
  const ups = f
    .calls()
    .split('\n')
    .filter((c) => / up -d(?! --wait)/.test(c));
  assert.deepEqual(
    ups.map((c) => c.split(' up ')[1]),
    ['-d worker', '-d --no-deps api worker'],
  );
});

for (const [key, value] of [
  ['POSTGRES_PASSWORD', `"${secret('\\"')}"`],
  ['POSTGRES_PASSWORD', secret('$')],
  ['MAILPIT_UI_PASSWORD', secret('\\')],
]) {
  test(`a value compose reads differently is refused before any change: ${key} ${value}`, (t) => {
    const f = fixture(t, `${CREDS}${key}=${value}\n`);
    const out = f.run(['up']);
    assert.notEqual(out.status, 0);
    assert.match(out.stdout + out.stderr, /single quotes/);
    assert.ok(!existsSync(join(f.root, 'sql')));
    assert.ok(!existsSync(join(f.root, 'calls')));
  });
}

test('a single-quoted value is literal for compose too and is synced as written', (t) => {
  const password = secret('$\\');
  const f = fixture(t, `POSTGRES_PASSWORD='${password}'\nMAILPIT_UI_PASSWORD=${MAIL}\n`);
  const out = f.run(['up']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(f.sql().includes(password.replaceAll('\\', '\\\\')));
});

test('quoted role passwords are SQL literals and errors cannot print them', (t) => {
  const password = secret("'");
  const f = fixture(t, `POSTGRES_PASSWORD="${password}"\nMAILPIT_UI_PASSWORD=${MAIL}\n`);
  const out = f.run();
  assert.equal(out.status, 0);
  assert.ok(f.sql().includes(password.replaceAll("'", "''")));
});

test('an unselected restart still brings up the whole stack', (t) => {
  const f = fixture(t, CREDS);
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
