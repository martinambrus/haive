import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  completeness,
  needsRedis,
  parseRows,
  readGated,
  rewriteEnv,
  selectRows,
} from '../lib/ci-gated.mjs';
import { readWorkflow } from './workflow.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = join(root, 'scripts', 'run-gated-tests.mjs');
const ciText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
// A malformed row must fail a named test, not stop the file from loading.
let gated;
let gatedError;
try {
  gated = readGated();
} catch (error) {
  gatedError = error;
}

// Rows are chosen from the list by property, so a change to the list moves the tests with it.
const rowText = (row) => readFileSync(join(root, 'packages', row.pkg, row.file), 'utf8');
const rowNeedsRedis = (row) => needsRedis(gated.stepEnv, rowText(row));
const sel = (row) => `${row.pkg}/${row.file}`;
const portVar = (variable) => variable.replace(/_URL$/, '_PORT');
const gatedRows = gated?.rows ?? [];
const plainPgRows = gatedRows.filter((row) => row.server === 'pg' && !rowNeedsRedis(row));
const PG_ROW = plainPgRows[0];
const PG_ROW2 = plainPgRows.find((row) => row.file !== PG_ROW.file);
const PG_ROW_B = plainPgRows.find((row) => row.db !== PG_ROW.db);
const VECTOR_ROW = gatedRows.find((row) => row.server === 'pgvector');
const REDIS_ROW = gatedRows.find(rowNeedsRedis);
// Two rows with different files that share one database on one server.
const SHARED_ROWS = (() => {
  for (const [at, first] of gatedRows.entries()) {
    const second = gatedRows
      .slice(at + 1)
      .find((r) => r.db === first.db && r.server === first.server && r.file !== first.file);
    if (second) return [first, second];
  }
  return [];
})();
const redisNamesOf = (row) =>
  Object.entries(gated.stepEnv)
    .filter(([name, value]) => /^rediss?:\/\//.test(value) && rowText(row).includes(name))
    .map(([name]) => name);

const declared = {
  postgres: { hostPorts: [5432], containerPort: 5432 },
  pgvector: { hostPorts: [5433], containerPort: 5432 },
  redis: { hostPorts: [6379], containerPort: 6379 },
};

// The CLI harness: stub docker and pnpm first on PATH, calls logged in a temp dir.
const base = mkdtempSync(join(tmpdir(), 'gated-cli-'));
const bin = join(base, 'bin');
mkdirSync(bin);
const stub = (name, source) =>
  writeFileSync(
    join(bin, name),
    `#!/bin/bash
n=$(( $(cat "$STUB_LOG/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_LOG/count"
printf '%s\\t%s\\t' "$n" "${name}" >> "$STUB_LOG/calls"
printf '%s\\037' "$@" >> "$STUB_LOG/calls"
printf '\\n' >> "$STUB_LOG/calls"
env > "$STUB_LOG/env-$n"
in_list() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }
${source}
`,
    { mode: 0o755 },
  );
stub(
  'docker',
  `case "$1" in
run)
  runs=$(( $(cat "$STUB_LOG/runs" 2>/dev/null || echo 0) + 1 ))
  echo "$runs" > "$STUB_LOG/runs"
  if [ "$runs" = "\${STUB_RUN_FAIL_AT:-0}" ]; then echo "stub: run refused" >&2; exit 125; fi
  echo stubcontainerid ;;
port)
  case "$2" in
    *-postgres) echo "127.0.0.1:54001" ;;
    *-pgvector) echo "127.0.0.1:54002" ;;
    *-redis) echo "127.0.0.1:54003" ;;
  esac ;;
exec)
  case "$3" in
    pg_isready) [ -z "\${STUB_NOT_READY:-}" ] || exit 2 ;;
    redis-cli) if [ "$4" = ping ]; then echo PONG; else echo OK; fi ;;
    psql)
      if [ -n "\${STUB_PROBE_FAIL_DB:-}" ] && [ "$8" = -tAc ] && [[ "$9" == *"'$STUB_PROBE_FAIL_DB'"* ]]; then
        echo "stub: probe refused" >&2; exit 1
      fi
      if [ -z "\${STUB_DB_ABSENT:-}" ] && [ "$7" = postgres ] && [ "$8" = -tAc ]; then echo 1; fi ;;
  esac ;;
logs) echo "stub log line" ;;
rm) [ -z "\${STUB_RM_FAIL:-}" ] || { echo "stub: rm refused" >&2; exit 1; } ;;
esac
exit 0`,
);
stub(
  'pnpm',
  `case " $* " in
*" migrate "*)
    [ -z "\${STUB_MIGRATE_FAIL:-}" ] || { echo "stub: migrate refused" >&2; exit 9; }
    if [ -n "\${STUB_MIGRATE_FAIL_DB:-}" ]; then
      case "\${DATABASE_URL:-}" in */"$STUB_MIGRATE_FAIL_DB") echo "stub: migrate refused" >&2; exit 9 ;; esac
    fi
    exit 0 ;;
esac
file=""; take=0; report=""
for arg in "$@"; do
if [ "$take" = 1 ]; then file="$arg"; take=0; fi
[ "$arg" = run ] && take=1
case "$arg" in --outputFile.json=*) report="\${arg#*=}" ;; esac
done
if in_list "\${STUB_HANG_FILES:-}" "$file"; then
  sleep 60 >/dev/null 2>&1 &
  echo $! > "$STUB_LOG/child"
  touch "$STUB_LOG/hung"
  wait
  exit 0
fi
if in_list "\${STUB_NO_REPORT_FILES:-}" "$file"; then exit 0; fi
if in_list "\${STUB_SKIP_FILES:-}" "$file"; then
printf '{"numPassedTests":3,"numFailedTests":0,"numPendingTests":1,"numTodoTests":0}' > "$report"
else
printf '{"numPassedTests":3,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0}' > "$report"
fi
if in_list "\${STUB_FAIL_FILES:-}" "$file"; then exit 1; fi
exit 0`,
);
after(() => rmSync(base, { recursive: true, force: true }));

// A pid is gone once it has no process, or only a zombie that awaits its reaper.
async function assertGone(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'the stub recorded its child pid');
  const deadline = Date.now() + 2000;
  for (;;) {
    let state = null;
    try {
      state = /^\S+ \(.*\) (\S)/.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1] ?? null;
    } catch {
      return;
    }
    if (state === null || state === 'Z') return;
    assert.ok(Date.now() < deadline, `child ${pid} is still running (state ${state})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pnpmOf = (out, word) =>
  out.calls.filter((call) => call.tool === 'pnpm' && call.args.includes(word));

function cli(args, { env = {}, onStart } = {}) {
  const log = mkdtempSync(join(base, 'log-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: base,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: base,
        STUB_LOG: log,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    let poll;
    if (onStart) {
      poll = setInterval(() => {
        if (existsSync(join(log, 'hung'))) {
          clearInterval(poll);
          onStart(child);
        }
      }, 20);
    }
    child.on('close', (status, signal) => {
      clearTimeout(guard);
      clearInterval(poll);
      const calls = existsSync(join(log, 'calls'))
        ? readFileSync(join(log, 'calls'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [n, tool, joined] = line.split('\t');
              const environment = {};
              for (const entry of readFileSync(join(log, `env-${n}`), 'utf8').split('\n')) {
                const at = entry.indexOf('=');
                if (at > 0) environment[entry.slice(0, at)] = entry.slice(at + 1);
              }
              return {
                tool,
                args: joined.split('\x1f').slice(0, -1),
                env: environment,
              };
            })
        : [];
      const childPid = existsSync(join(log, 'child'))
        ? Number(readFileSync(join(log, 'child'), 'utf8'))
        : null;
      rmSync(log, { recursive: true, force: true });
      resolve({ status, signal, output, calls, childPid });
    });
  });
}

describe('the gated list', () => {
  it('parses strictly, as ci.yml has it', () => {
    if (gatedError) throw gatedError;
  });

  it('is the list in ci.yml, all five columns', () => {
    const raw = /<<'GATED'\n([\s\S]+?)\n[ ]*GATED\n/.exec(ciText)[1];
    const expected = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pkg, file, variable, db, server] = line.split(' ');
        return { pkg, file, var: variable, db, server };
      });
    assert.ok(expected.length > 50);
    assert.deepEqual(gated.rows, expected);
  });

  it('carries the services and the env the job declares', () => {
    const job = readWorkflow('ci.yml').jobs['postgres-gated'];
    const step = job.steps.find((candidate) => /<<'GATED'/.test(candidate.run ?? ''));
    const declaredServices = Object.entries(job.services);
    assert.deepEqual(Object.keys(gated.services).sort(), Object.keys(job.services).sort());
    assert.ok(declaredServices.length >= 3);
    for (const [name, service] of declaredServices) {
      const ports = service.ports.map((port) => String(port).split(':').map(Number));
      assert.ok(ports.length > 0, name);
      assert.equal(gated.services[name].image, service.image, name);
      assert.deepEqual(gated.services[name].env, service.env ?? {}, name);
      assert.deepEqual(
        gated.services[name].hostPorts,
        ports.map(([host]) => host),
        name,
      );
      assert.equal(gated.services[name].containerPort, ports[0].at(-1), name);
    }
    // An env value built from a `${{ }}` expression has no meaning here, so it is dropped.
    const literal = (env) =>
      Object.fromEntries(Object.entries(env).filter(([, value]) => !value.includes('${{')));
    assert.ok(Object.keys(job.env).length > 0 && Object.keys(step.env).length > 0);
    assert.deepEqual(gated.jobEnv, literal(job.env));
    assert.deepEqual(gated.stepEnv, literal(step.env));
    assert.ok(Object.values(step.env).some((value) => value.includes('${{')));
    assert.equal('PG_CONTAINER' in gated.stepEnv, false);
  });

  it('names what is missing', () => {
    assert.throws(() => readGated({ jobs: {} }), /postgres-gated/);
    assert.throws(
      () => readGated({ jobs: { 'postgres-gated': { steps: [{ run: 'echo' }] } } }),
      /GATED/,
    );
  });
});

describe('the gated loop agrees with the runner', () => {
  const listPattern = /<<'GATED'\n([\s\S]+?)\nGATED(?:\n|$)/;
  const step = readWorkflow('ci.yml').jobs['postgres-gated'].steps.find((s) =>
    listPattern.test(s.run ?? ''),
  );
  assert.ok(step, 'ci.yml must contain a step with a GATED list');
  const fullList = listPattern.exec(step.run)[1];
  const passing = { numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };

  function loop(list, report) {
    const dir = mkdtempSync(join(tmpdir(), 'gated-loop-'));
    try {
      const stub = (name, source) =>
        writeFileSync(join(dir, name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
      stub('docker', 'if [[ "$*" == *-tAc* ]]; then echo 1; fi');
      stub(
        'pnpm',
        `printf '%s\\t%s\\n' "$(printf '%s\\037' "$@")" "$(compgen -e | sort | tr '\\n' ' ')" >> "$ALL"
if [[ "$*" == *vitest* ]]; then
  printf '%s\\t%s\\n' "$*" "$(env | /usr/bin/grep '=postgres://' | tr '\\n' ' ')" >> "$CALLS"
  for arg in "$@"; do
    case "$arg" in --outputFile.json=*) printf '%s' "$STUB_REPORT" > "\${arg#*=}" ;; esac
  done
fi`,
      );
      const script = step.run.replace(fullList, list.join('\n'));
      const loopEnv = {
        PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        RUNNER_TEMP: dir,
        PG_CONTAINER: 'postgres-stub',
        PGVECTOR_CONTAINER: 'pgvector-stub',
        CALLS: join(dir, 'calls'),
        ALL: join(dir, 'all'),
        STUB_REPORT: JSON.stringify(report),
      };
      const out = spawnSync('bash', ['-e', '-c', script], {
        cwd: dir,
        env: loopEnv,
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.ifError(out.error);
      const calls = existsSync(join(dir, 'calls'))
        ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
        : [];
      // Every pnpm call: its argv and the env names that reached it beyond the harness's own.
      const harness = new Set([...Object.keys(loopEnv), 'PWD', 'SHLVL', '_', 'OLDPWD']);
      const all = existsSync(join(dir, 'all'))
        ? readFileSync(join(dir, 'all'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const [argv, names] = line.split('\t');
              return {
                argv: argv.split('\x1f').slice(0, -1),
                added: names.split(' ').filter((name) => name && !harness.has(name)),
              };
            })
        : [];
      return { status: out.status, output: out.stdout + out.stderr, calls, all };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const reduced = [];
  const seen = new Set();
  for (const line of fullList.split('\n').filter(Boolean)) {
    const [pkg, , , , server] = line.split(' ');
    if (seen.has(`${pkg} ${server}`)) continue;
    seen.add(`${pkg} ${server}`);
    reduced.push(line);
  }

  it('runs the same pkg, file, var, db and server for every row', () => {
    const out = loop(reduced, passing);
    assert.equal(out.status, 0, out.output);
    assert.equal(out.calls.length, reduced.length);
    const serverOf = (port) =>
      gated.services.postgres.hostPorts.includes(Number(port))
        ? 'pg'
        : gated.services.pgvector.hostPorts.includes(Number(port))
          ? 'pgvector'
          : `unknown-port-${port}`;
    const seenRows = out.calls.map((call) => {
      const [args, envs] = call.split('\t');
      const words = args.split(' ');
      const pkg = /^@haive\/(.+)$/.exec(words[words.indexOf('--filter') + 1])[1];
      const file = words[words.indexOf('run') + 1];
      const urls = envs
        .trim()
        .split(' ')
        .map((entry) => /^([A-Z0-9_]+)=postgres:\/\/[^@]+@localhost:(\d+)\/(\S+)$/.exec(entry))
        .filter(Boolean);
      assert.equal(urls.length, 1, call);
      return { pkg, file, var: urls[0][1], db: urls[0][3], server: serverOf(urls[0][2]) };
    });
    assert.deepEqual(
      seenRows,
      reduced.map((line) => {
        const [pkg, file, variable, db, server] = line.split(' ');
        return { pkg, file, var: variable, db, server };
      }),
    );
    for (const row of seenRows) {
      assert.ok(
        gated.rows.some((r) => JSON.stringify(r) === JSON.stringify(row)),
        `the runner has no row ${JSON.stringify(row)}`,
      );
    }
  });

  const normalized = (argv) =>
    argv.map((arg) => arg.replace(/^(--outputFile\.json=).*/, '$1REPORT'));

  it('passes the same argv and env names to migrate and vitest as the runner does', async () => {
    const out = loop(reduced, passing);
    assert.equal(out.all.length, reduced.length * 2, 'one migrate and one vitest call per row');
    for (const [at, line] of reduced.entries()) {
      const [pkg, file, variable] = line.split(' ');
      const ciMigrate = out.all[at * 2];
      const ciVitest = out.all[at * 2 + 1];
      const mine = await cli([`${pkg}/${file}`]);
      assert.equal(mine.status, 0, mine.output);
      const myMigrate = pnpmOf(mine, 'migrate').at(-1);
      const myVitest = pnpmOf(mine, 'vitest')[0];
      assert.deepEqual(ciMigrate.argv, myMigrate.args, `${file} migrate argv`);
      assert.deepEqual(normalized(ciVitest.argv), normalized(myVitest.args), `${file} vitest argv`);
      assert.ok(ciMigrate.added.includes('DATABASE_URL'), `${file}: ${ciMigrate.added}`);
      assert.ok(ciVitest.added.includes(variable), `${file}: ${ciVitest.added}`);
      for (const [what, ci, theirs] of [
        ['migrate', ciMigrate, myMigrate],
        ['vitest', ciVitest, myVitest],
      ]) {
        for (const name of ci.added) {
          assert.ok(
            name in theirs.env,
            `${file}: the CI ${what} call sets ${name}, the runner does not`,
          );
        }
      }
    }
  });

  it('runs the migrate step of the job as the runner does at setup', async () => {
    const mine = await cli([sel(PG_ROW)]);
    assert.equal(mine.status, 0, mine.output);
    const migrate = readWorkflow('ci.yml').jobs['postgres-gated'].steps.find(
      (candidate) => candidate.id === 'migrate',
    );
    assert.ok(migrate, 'the job has a step with id migrate');
    assert.equal(migrate.run.trim(), `pnpm ${pnpmOf(mine, 'migrate')[0].args.join(' ')}`);
  });

  const reports = [
    { numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
    { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
    { numPassedTests: 3, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0 },
    { numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 1 },
    { numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 },
    { numPassedTests: 3, numFailedTests: 0 },
  ];
  for (const report of reports) {
    it(`reaches the loop's verdict for ${JSON.stringify(report)}`, () => {
      const out = loop(reduced.slice(0, 1), report);
      const file = reduced[0].split(' ')[1];
      assert.equal(
        out.output.includes('did not run in full'),
        !completeness(report).ok,
        out.output,
      );
      assert.ok(out.output.includes(`${file}: ${completeness(report).line}`), out.output);
    });
  }
});

describe('the gated list parser', () => {
  const good = 'api test/a.test.ts A_URL a_db pg';
  it('parses rows and skips blank lines', () => {
    assert.deepEqual(parseRows(`\n${good}\n\nworker test/b.test.ts B_URL b_db pgvector\n`), [
      { pkg: 'api', file: 'test/a.test.ts', var: 'A_URL', db: 'a_db', server: 'pg' },
      { pkg: 'worker', file: 'test/b.test.ts', var: 'B_URL', db: 'b_db', server: 'pgvector' },
    ]);
  });
  const bad = [
    ['a double space', 'api  test/a.test.ts A_URL a_db pg'],
    ['a tab', 'api\ttest/a.test.ts A_URL a_db pg'],
    ['four columns', 'api test/a.test.ts A_URL a_db'],
    ['six columns', `${good} extra`],
    ['an unknown server', 'api test/a.test.ts A_URL a_db pgx'],
    ['an uppercase database', 'api test/a.test.ts A_URL A_DB pg'],
    ['a database with a dash', 'api test/a.test.ts A_URL a-db pg'],
    ['a database that starts with a digit', 'api test/a.test.ts A_URL 1db pg'],
    ['a leading space', ` ${good}`],
    ['a trailing space', `${good} `],
  ];
  for (const [name, row] of bad) {
    it(`rejects ${name}`, () =>
      assert.throws(
        () => parseRows(`${good}\n${row}`),
        (error) => error.message === `malformed GATED row: "${row}"`,
      ));
  }
});

describe('the gated selection', () => {
  const rows = parseRows(
    [
      'api test/a.test.ts A_URL a_db pg',
      'worker test/a.test.ts A2_URL a2_db pg',
      'worker test/b.test.ts B_URL b_db pgvector',
      'worker test/b.test.ts B_URL b_db pgvector',
      'database test/c.test.ts C_URL c_db pg',
    ].join('\n'),
  );
  const files = (selected) => selected.map((row) => `${row.pkg}:${row.file}`);
  it('takes all, a package or a file in each form, in list order, once', () => {
    assert.equal(selectRows(rows, ['all']).length, 4);
    assert.deepEqual(files(selectRows(rows, ['worker'])), [
      'worker:test/a.test.ts',
      'worker:test/b.test.ts',
    ]);
    assert.deepEqual(files(selectRows(rows, ['test/c.test.ts'])), ['database:test/c.test.ts']);
    assert.deepEqual(files(selectRows(rows, ['api/test/a.test.ts'])), ['api:test/a.test.ts']);
    assert.deepEqual(files(selectRows(rows, ['packages/worker/test/b.test.ts'])), [
      'worker:test/b.test.ts',
    ]);
  });
  it('selects both packages for a file present in two', () => {
    assert.deepEqual(files(selectRows(rows, ['test/a.test.ts'])), [
      'api:test/a.test.ts',
      'worker:test/a.test.ts',
    ]);
  });
  it('keeps list order and drops repeats across selectors', () => {
    assert.deepEqual(files(selectRows(rows, ['database', 'worker', 'test/a.test.ts', 'all'])), [
      'api:test/a.test.ts',
      'worker:test/a.test.ts',
      'worker:test/b.test.ts',
      'database:test/c.test.ts',
    ]);
  });
  it('names every unknown selector and refuses an empty selection', () => {
    assert.throws(
      () => selectRows(rows, ['worker', 'nope', 'test/missing.test.ts']),
      (error) => error.message.includes('nope') && error.message.includes('test/missing.test.ts'),
    );
    assert.throws(() => selectRows(rows, []), Error);
  });
});

describe('the gated env rewrite', () => {
  const env = {
    DATABASE_URL: 'postgres://haive:old@localhost:5432/haive',
    VECTOR_URL: 'postgresql://haive:old@localhost:5433/vec?sslmode=disable',
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_URL: 'redis://127.0.0.1:6379/13',
    NODE_ENV: 'test',
    WEB_URL: 'http://localhost:5432/x',
    PG_NO_PORT: 'postgres://u@localhost/db',
    REDIS_NO_PORT: 'redis://localhost',
    PG_UNDECLARED: 'postgres://u@localhost:5999/db',
    REDIS_UNDECLARED: 'redis://localhost:6390/1',
    PG_UNPARSEABLE: 'postgres://u@:notaport/db',
  };
  const running = {
    postgres: { port: 41000, user: 'u', password: 'p' },
    pgvector: { port: 41001, user: 'u2', password: 'p2' },
    redis: { port: 42000 },
  };
  it('points every declared service at its throwaway, keeping path and query', () => {
    assert.deepEqual(rewriteEnv(env, declared, running), {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:41000/haive',
      VECTOR_URL: 'postgresql://u2:p2@127.0.0.1:41001/vec?sslmode=disable',
      REDIS_URL: 'redis://127.0.0.1:42000',
      QUEUE_URL: 'redis://127.0.0.1:42000/13',
      NODE_ENV: 'test',
      WEB_URL: 'http://localhost:5432/x',
      PG_NO_PORT: 'postgres://u:p@127.0.0.1:41000/db',
      REDIS_NO_PORT: 'redis://127.0.0.1:42000',
    });
  });
  it('never lets a store URL through: an omitted or undeclared port is mapped or dropped', () => {
    for (const set of [running, { postgres: running.postgres }, {}]) {
      const out = rewriteEnv(env, declared, set);
      for (const name of ['PG_UNDECLARED', 'REDIS_UNDECLARED', 'PG_UNPARSEABLE']) {
        assert.equal(name in out, false, name);
      }
      for (const [name, value] of Object.entries(out)) {
        if (/^(postgres|redis)/.test(value)) assert.match(value, /@?127\.0\.0\.1:4\d{4}/, name);
      }
    }
  });
  it('drops a URL to a service the run does not own', () => {
    assert.deepEqual(rewriteEnv(env, declared, { postgres: running.postgres }), {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:41000/haive',
      NODE_ENV: 'test',
      WEB_URL: 'http://localhost:5432/x',
      PG_NO_PORT: 'postgres://u:p@127.0.0.1:41000/db',
    });
    assert.deepEqual(rewriteEnv(env, declared, {}), {
      NODE_ENV: 'test',
      WEB_URL: 'http://localhost:5432/x',
    });
  });
});

describe('the gated completeness verdict', () => {
  const report = (passed, failed, pending, todo) => ({
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: todo,
  });
  it('prints the format CI prints', () => {
    assert.equal(completeness(report(3, 0, 0, 0)).line, 'passed=3 failed=0 skipped=0 todo=0');
  });
  it('accepts only a run that passed something and skipped nothing', () => {
    assert.equal(completeness(report(3, 0, 0, 0)).ok, true);
    assert.equal(completeness(report(0, 0, 0, 0)).ok, false);
    assert.equal(completeness(report(3, 0, 1, 0)).ok, false);
    assert.equal(completeness(report(3, 0, 0, 1)).ok, false);
  });
  it('passes a report without the pending and todo counts, as the CI check does', () => {
    assert.equal(completeness({ numPassedTests: 3, numFailedTests: 0 }).ok, true);
    assert.equal(completeness({ numFailedTests: 1 }).ok, false);
  });
});

describe('the gated Redis need', () => {
  const unique = [...new Map(gatedRows.map((row) => [sel(row), row])).values()];
  // An assignment to the variable is not a read of it.
  const readNames = (row) =>
    [...rowText(row).matchAll(/process\.env\.([A-Z0-9_]*REDIS_URL)\b(?!\s*=[^=])/g)].map(
      (match) => match[1],
    );
  it('detects exactly the gated files that read a Redis URL variable', () => {
    const readers = unique.filter((row) => readNames(row).length > 0);
    assert.ok(readers.length > 0);
    for (const row of unique) {
      assert.equal(
        needsRedis(gated.stepEnv, rowText(row)),
        readNames(row).length > 0,
        `${sel(row)} needs Redis only if it reads a Redis URL variable`,
      );
    }
    for (const row of readers) {
      for (const name of readNames(row)) {
        assert.ok(name in gated.stepEnv, `${sel(row)} reads ${name}, which the step must set`);
      }
    }
  });
  it('finds none in a file that reads no Redis variable', () => {
    assert.equal(rowNeedsRedis(PG_ROW), false);
  });
});

// The CLI against stub docker and pnpm: no real docker, no real pnpm.
describe('the gated runner', () => {
  const dockerCalls = (out, verb) =>
    out.calls.filter((call) => call.tool === 'docker' && call.args[0] === verb);
  const pnpmCalls = (out, word) =>
    out.calls.filter((call) => call.tool === 'pnpm' && call.args.includes(word));
  const urlOf = (value) => new URL(value);
  const names = (out) =>
    dockerCalls(out, 'run').map((call) => call.args[call.args.indexOf('--name') + 1]);
  const lastCall = (out) => out.calls.at(-1);

  function assertRemoved(out, expectedNames = names(out)) {
    const last = lastCall(out);
    assert.equal(last.tool, 'docker', out.output);
    assert.deepEqual(last.args.slice(0, 2), ['rm', '-fv']);
    for (const name of expectedNames) assert.ok(last.args.includes(name), out.output);
  }

  it('exits 2 before any container for no selection, -h or an unknown selection', async () => {
    for (const args of [[], ['-h'], ['nosuch'], [sel(PG_ROW), 'nosuch']]) {
      const out = await cli(args);
      assert.equal(out.status, 2, out.output);
      assert.equal(out.calls.length, 0, out.output);
      assert.match(out.output, /gen-modules/);
    }
    assert.match((await cli(['nosuch'])).output, /nosuch/);
  });

  it('rejects a bad limit override before any container', async () => {
    for (const limits of [
      '{"bogusS":1}',
      '{"rowS":0}',
      '{"rowS":-3}',
      '{"rowS":"x"}',
      '{"rowS":1e999}',
    ]) {
      const out = await cli(['database'], { env: { RUN_GATED_TESTS_LIMITS: limits } });
      assert.equal(out.status, 2, out.output);
      assert.equal(out.calls.length, 0, out.output);
    }
  });

  it('runs one Postgres row the way the CI loop does and removes its container', async () => {
    const out = await cli([sel(PG_ROW)]);
    assert.equal(out.status, 0, out.output);
    const { file, var: variable, db } = PG_ROW;
    const runs = dockerCalls(out, 'run');
    assert.equal(runs.length, 1);
    const [name] = names(out);
    assert.match(name, /^gated-tests-[0-9a-f]{8}-postgres$/);
    assert.doesNotMatch(name, /^haive-/);
    assert.ok(runs[0].args.includes('127.0.0.1::5432'));
    assert.equal(runs[0].args.at(-1), gated.services.postgres.image);
    assert.ok(runs[0].args.includes('POSTGRES_USER=haive'));
    assert.ok(runs[0].args.includes('POSTGRES_DB=haive'));
    assert.ok(runs[0].args.includes('POSTGRES_PASSWORD'));
    assert.ok(!runs[0].args.some((arg) => arg.includes('haive_dev_password')));
    const migrations = pnpmCalls(out, 'migrate');
    assert.equal(migrations.length, 2);
    assert.deepEqual(migrations[0].args, ['--filter', '@haive/database', 'migrate']);
    const jobUrl = urlOf(migrations[0].env.DATABASE_URL);
    assert.equal(jobUrl.hostname, '127.0.0.1');
    assert.equal(jobUrl.port, '54001');
    assert.equal(jobUrl.pathname, '/haive');
    assert.equal(jobUrl.username, 'haive');
    const rowUrl = urlOf(migrations[1].env.DATABASE_URL);
    assert.equal(rowUrl.hostname, '127.0.0.1');
    assert.equal(rowUrl.port, '54001');
    assert.equal(rowUrl.pathname, `/${db}`);
    const vitest = pnpmCalls(out, 'vitest');
    assert.equal(vitest.length, 1);
    const args = vitest[0].args;
    assert.deepEqual(args.slice(0, 6), [
      '--filter',
      `@haive/${PG_ROW.pkg}`,
      'exec',
      'vitest',
      'run',
      file,
    ]);
    assert.equal(args[6], '--reporter=default');
    assert.equal(args[7], '--reporter=json');
    assert.equal(args[8], '--maxWorkers=2');
    assert.match(args[9], new RegExp(`^--outputFile\\.json=.+${db}\\.json$`));
    assert.equal(args.length, 10);
    assert.equal(vitest[0].env[variable], migrations[1].env.DATABASE_URL);
    if (portVar(variable) !== variable) assert.equal(vitest[0].env[portVar(variable)], '54001');
    assert.equal(urlOf(vitest[0].env.DATABASE_URL).pathname, '/haive');
    for (const name of [
      'REDIS_URL',
      ...Object.keys(gated.stepEnv).filter((n) => /REDIS_URL$/.test(n)),
    ]) {
      assert.equal(vitest[0].env[name], undefined, name);
    }
    const probe = out.calls.find((call) => call.args.includes('psql'));
    assert.deepEqual(probe.args.slice(0, 2), ['exec', name]);
    assert.match(out.output, new RegExp(`${file}: passed=3 failed=0 skipped=0 todo=0`));
    assert.ok(
      out.output.includes(
        `run-gated-tests: ${name} (${gated.services.postgres.image}) on 127.0.0.1:54001`,
      ),
      out.output,
    );
    assert.ok(!out.output.includes(jobUrl.password), 'a password reached the output');
    assertRemoved(out);
  });

  it('uses a different random password each run, never the one in ci.yml', async () => {
    const passwords = [];
    for (let i = 0; i < 2; i += 1) {
      const out = await cli([sel(PG_ROW)]);
      assert.equal(out.status, 0, out.output);
      passwords.push(urlOf(pnpmCalls(out, 'migrate')[0].env.DATABASE_URL).password);
    }
    assert.notEqual(passwords[0], passwords[1]);
    for (const password of passwords) {
      assert.ok(password.length >= 16);
      assert.ok(!ciText.includes(password));
      assert.notEqual(password, 'haive_dev_password');
    }
  });

  it('creates a missing database before the row runs', async () => {
    const out = await cli([sel(PG_ROW)], { env: { STUB_DB_ABSENT: '1' } });
    assert.equal(out.status, 0, out.output);
    const create = out.calls.find((call) => call.args.includes(`CREATE DATABASE ${PG_ROW.db}`));
    assert.ok(create, out.output);
    assert.ok(out.calls.indexOf(create) < out.calls.indexOf(pnpmCalls(out, 'vitest')[0]));
  });

  it('starts only pgvector for a pgvector row', async () => {
    const out = await cli([sel(VECTOR_ROW)]);
    assert.equal(out.status, 0, out.output);
    assert.equal(names(out).length, 1);
    assert.match(names(out)[0], /^gated-tests-[0-9a-f]{8}-pgvector$/);
    assert.equal(dockerCalls(out, 'run')[0].args.at(-1), gated.services.pgvector.image);
    assert.equal(pnpmCalls(out, 'migrate').length, 1);
    const [vitest] = pnpmCalls(out, 'vitest');
    assert.equal(urlOf(vitest.env[VECTOR_ROW.var]).port, '54002');
    assert.equal(vitest.env.DATABASE_URL, undefined);
    assertRemoved(out);
  });

  it('starts Redis for a row that reads a Redis variable and keeps its database index', async () => {
    const out = await cli([sel(REDIS_ROW)]);
    assert.equal(out.status, 0, out.output);
    assert.deepEqual(
      names(out)
        .map((name) => name.replace(/^gated-tests-[0-9a-f]{8}-/, ''))
        .sort(),
      ['postgres', 'redis'],
    );
    const redisRun = dockerCalls(out, 'run').find((call) => call.args.at(-1).startsWith('redis:'));
    assert.ok(redisRun.args.includes('127.0.0.1::6379'));
    assert.ok(
      out.calls.some((call) =>
        call.args.join(' ').includes('CONFIG SET maxmemory-policy noeviction'),
      ),
    );
    const [vitest] = pnpmCalls(out, 'vitest');
    // The expected URL is the one ci.yml declares with its host and port swapped, path kept.
    const swapped = (value) => value.replace(/\/\/[^/]+/, '//127.0.0.1:54003');
    const redisNames = redisNamesOf(REDIS_ROW);
    assert.ok(redisNames.length > 0);
    for (const name of redisNames) assert.equal(vitest.env[name], swapped(gated.stepEnv[name]));
    assert.equal(vitest.env.REDIS_URL, swapped(gated.jobEnv.REDIS_URL));
    assertRemoved(out);
  });

  it('keeps one failing row from stopping the rest and still removes containers', async () => {
    const out = await cli([sel(PG_ROW), sel(PG_ROW2)], {
      env: { STUB_FAIL_FILES: PG_ROW2.file },
    });
    assert.equal(out.status, 1, out.output);
    assert.equal(pnpmCalls(out, 'vitest').length, 2);
    assert.ok(
      out.output.includes(`FAILED `) && out.output.includes(`${PG_ROW2.pkg} ${PG_ROW2.file}`),
    );
    assert.match(out.output, new RegExp(`passed [0-9.]+s ${PG_ROW.pkg} ${PG_ROW.file}`));
    assert.match(out.output, new RegExp(`FAILED [0-9.]+s ${PG_ROW2.pkg} ${PG_ROW2.file}`));
    assertRemoved(out);
  });

  it('counts a skipped test as an incomplete run', async () => {
    const out = await cli([sel(PG_ROW)], {
      env: { STUB_SKIP_FILES: PG_ROW.file },
    });
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /INCOMPLETE/);
    assertRemoved(out);
  });

  it('never judges a row by the report an earlier row left on the same database', async () => {
    const [first, second] = SHARED_ROWS;
    assert.ok(second, 'the list has two rows with different files that share a database');
    const out = await cli([sel(first), sel(second)], {
      env: { STUB_NO_REPORT_FILES: second.file },
    });
    assert.equal(out.status, 1, out.output);
    assert.equal(pnpmCalls(out, 'vitest').length, 2);
    assert.ok(out.output.includes(`${second.file}: no test report`), out.output);
    assert.match(out.output, new RegExp(`INCOMPLETE [0-9.]+s ${second.pkg} ${second.file}`));
    assert.match(out.output, new RegExp(`passed [0-9.]+s ${first.pkg} ${first.file}`));
    assertRemoved(out);
  });

  it('stops before any row when the job database migration fails', async () => {
    const out = await cli([sel(PG_ROW)], { env: { STUB_MIGRATE_FAIL: '1' } });
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /stub: migrate refused/);
    assert.match(out.output, /setup failed, no row ran/);
    assert.equal(pnpmCalls(out, 'vitest').length, 0);
    assertRemoved(out);
  });

  it('counts a row whose own migration fails as FAILED and runs the next row', async () => {
    const out = await cli([sel(PG_ROW), sel(PG_ROW_B)], {
      env: { STUB_MIGRATE_FAIL_DB: PG_ROW.db },
    });
    assert.equal(out.status, 1, out.output);
    assert.ok(out.output.includes(`migrate failed for ${PG_ROW.db}`), out.output);
    assert.match(out.output, /stub: migrate refused/);
    assert.doesNotMatch(out.output, /setup failed/);
    assert.equal(pnpmCalls(out, 'vitest').length, 1);
    assert.equal(pnpmCalls(out, 'vitest')[0].args[5], PG_ROW_B.file);
    assert.match(out.output, new RegExp(`FAILED [0-9.]+s ${PG_ROW.pkg} ${PG_ROW.file}`));
    assert.match(out.output, new RegExp(`passed [0-9.]+s ${PG_ROW_B.pkg} ${PG_ROW_B.file}`));
    assertRemoved(out);
  });

  it('counts a failed database probe as FAILED, runs nothing for that row, then the next', async () => {
    const out = await cli([sel(PG_ROW), sel(PG_ROW_B)], {
      env: { STUB_PROBE_FAIL_DB: PG_ROW.db },
    });
    assert.equal(out.status, 1, out.output);
    assert.ok(out.output.includes(`database probe failed for ${PG_ROW.file}`), out.output);
    const forFirst = out.calls.filter(
      (call) => call.tool === 'pnpm' && call.env.DATABASE_URL?.endsWith(`/${PG_ROW.db}`),
    );
    assert.deepEqual(forFirst, []);
    assert.equal(pnpmCalls(out, 'vitest').length, 1);
    assert.equal(pnpmCalls(out, 'vitest')[0].args[5], PG_ROW_B.file);
    assert.match(out.output, new RegExp(`FAILED [0-9.]+s ${PG_ROW.pkg} ${PG_ROW.file}`));
    assert.match(out.output, new RegExp(`passed [0-9.]+s ${PG_ROW_B.pkg} ${PG_ROW_B.file}`));
    assertRemoved(out);
  });

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    it(`removes its containers, leaves no child and exits ${code} on ${signal} mid-test`, async () => {
      const out = await cli([sel(PG_ROW)], {
        env: { STUB_HANG_FILES: PG_ROW.file },
        onStart: (child) => child.kill(signal),
      });
      assert.equal(out.status, code, out.output);
      assertRemoved(out);
      await assertGone(out.childPid);
    });
  }

  it('keeps a failing first row from stopping the second', async () => {
    const out = await cli([sel(PG_ROW), sel(PG_ROW2)], {
      env: { STUB_FAIL_FILES: PG_ROW.file },
    });
    assert.equal(out.status, 1, out.output);
    assert.equal(pnpmCalls(out, 'vitest').length, 2);
    assert.match(out.output, new RegExp(`FAILED [0-9.]+s ${PG_ROW.pkg} ${PG_ROW.file}`));
    assert.match(out.output, new RegExp(`passed [0-9.]+s ${PG_ROW2.pkg} ${PG_ROW2.file}`));
    assertRemoved(out);
  });

  it('names the containers to remove when it cannot confirm their removal', async () => {
    for (const env of [{}, { STUB_FAIL_FILES: PG_ROW.file }]) {
      const out = await cli([sel(PG_ROW)], { env: { STUB_RM_FAIL: '1', ...env } });
      assert.equal(out.status, env.STUB_FAIL_FILES ? 1 : 0, out.output);
      const [name] = names(out);
      assert.ok(
        out.output
          .split('\n')
          .some(
            (line) =>
              /docker rm -fv\b.*gated-tests-[0-9a-f]{8}-postgres/.test(line) && line.includes(name),
          ),
        out.output,
      );
      assert.doesNotMatch(out.output, /remove by hand/);
    }
  });

  it('takes one leading -- as pnpm forwards it, and -- alone as no selection', async () => {
    const out = await cli(['--', sel(PG_ROW)]);
    assert.equal(out.status, 0, out.output);
    assert.equal(pnpmCalls(out, 'vitest').length, 1);
    assert.equal(pnpmCalls(out, 'vitest')[0].args[5], PG_ROW.file);
    assertRemoved(out);
    const none = await cli(['--']);
    assert.equal(none.status, 2, none.output);
    assert.equal(none.calls.length, 0, none.output);
  });

  it('strips the variable of a row it did not select from the test process', async () => {
    const other = gatedRows.find((row) => row.var !== PG_ROW.var && row.server === 'pg');
    assert.ok(other, 'the list has a row whose variable differs from the selected one');
    const leak = 'postgres://leak:leak@leak.invalid:1/leak';
    const out = await cli([sel(PG_ROW)], { env: { [other.var]: leak } });
    assert.equal(out.status, 0, out.output);
    for (const call of out.calls.filter((c) => c.tool === 'pnpm')) {
      assert.equal(call.env[other.var], undefined, other.var);
    }
  });

  it('gives up on a server that is never ready, with its logs, and removes it', async () => {
    const out = await cli([sel(PG_ROW)], {
      env: { STUB_NOT_READY: '1', RUN_GATED_TESTS_LIMITS: '{"readyS":1}' },
    });
    assert.equal(out.status, 1, out.output);
    assert.equal(pnpmCalls(out, 'vitest').length, 0);
    assert.ok(dockerCalls(out, 'logs').length > 0);
    assert.ok(out.output.includes('stub log line'));
    assertRemoved(out);
  });

  it('removes the first container when the second docker run fails', async () => {
    const out = await cli([sel(PG_ROW), sel(VECTOR_ROW)], {
      env: { STUB_RUN_FAIL_AT: '2' },
    });
    assert.equal(out.status, 1, out.output);
    assert.equal(names(out).length, 2);
    assert.equal(pnpmCalls(out, 'vitest').length, 0);
    assertRemoved(out);
  });

  it('kills a row that hangs at its limit, reports TIMEOUT and removes containers', async () => {
    const out = await cli([sel(PG_ROW)], {
      env: {
        STUB_HANG_FILES: PG_ROW.file,
        RUN_GATED_TESTS_LIMITS: '{"rowS":1}',
      },
    });
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /TIMEOUT/);
    assertRemoved(out);
    await assertGone(out.childPid);
  });

  it('never lets a developer shell value reach the test process', async () => {
    const leak = 'postgres://leak:leak@leak.invalid:1/leak';
    const redisNames = Object.keys(gated.stepEnv).filter((name) => /REDIS_URL$/.test(name));
    const out = await cli([sel(PG_ROW)], {
      env: {
        DATABASE_URL: leak,
        REDIS_URL: 'redis://leak.invalid:1',
        [PG_ROW.var]: leak,
        ...Object.fromEntries(redisNames.map((name) => [name, 'redis://leak.invalid:1/14'])),
        JWT_SECRET: 'leak',
      },
    });
    assert.equal(out.status, 0, out.output);
    for (const call of out.calls.filter((c) => c.tool === 'pnpm')) {
      assert.equal(urlOf(call.env.DATABASE_URL).hostname, '127.0.0.1');
      assert.equal(call.env.REDIS_URL, undefined);
      for (const name of redisNames) assert.equal(call.env[name], undefined, name);
      assert.notEqual(call.env.JWT_SECRET, 'leak');
    }
    assert.equal(urlOf(pnpmCalls(out, 'vitest')[0].env[PG_ROW.var]).hostname, '127.0.0.1');
  });

  it('leaves no temp report directory behind', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('gated-tests-')));
    const out = await cli([sel(PG_ROW)]);
    assert.equal(out.status, 0, out.output);
    const left = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('gated-tests-') && !before.has(n),
    );
    assert.deepEqual(left, []);
  });
});
