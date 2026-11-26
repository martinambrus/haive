// Runs rows of the CI "Postgres-gated tests" job against throwaway containers this script starts
// and always removes. The row list, images and env come from ci.yml (scripts/lib/ci-gated.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeness, needsRedis, readGated, rewriteEnv, selectRows } from './lib/ci-gated.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Limits in seconds. RUN_GATED_TESTS_LIMITS (a JSON object) overrides them for tests.
const LIMITS = {
  dockerS: 60, // any docker command
  startS: 300, // docker run, which may pull an image
  readyS: 90, // a server accepting connections
  migrateS: 180,
  rowS: 600, // one test file
};

const USAGE = `usage: node scripts/run-gated-tests.mjs <selection>...
selection: all | a package of the GATED list | a row file, as
  test/x.test.ts, <pkg>/test/x.test.ts or packages/<pkg>/test/x.test.ts
prerequisites, as the CI job does them: pnpm install; build @haive/database and @haive/shared;
  build @haive/web-kit and ./modules/*; node scripts/gen-modules.mjs`;

const fail2 = (message) => {
  if (message) console.error(`run-gated-tests: ${message}`);
  console.error(USAGE);
  process.exit(2);
};

function readLimits(raw) {
  const limits = { ...LIMITS };
  if (raw === undefined) return limits;
  const given = JSON.parse(raw);
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new Error('RUN_GATED_TESTS_LIMITS must be a JSON object');
  }
  for (const [key, value] of Object.entries(given)) {
    if (!(key in LIMITS)) throw new Error(`RUN_GATED_TESTS_LIMITS: unknown key "${key}"`);
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
      throw new Error(`RUN_GATED_TESTS_LIMITS: "${key}" must be a positive number`);
    }
    limits[key] = value;
  }
  return limits;
}

// pnpm forwards the `--` of `pnpm test:gated -- <selection>`; drop that one.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
if (args.length === 0 || args.includes('-h') || args.includes('--help')) fail2();

let limits;
let gated;
let selected;
let redisNeeded;
try {
  limits = readLimits(process.env.RUN_GATED_TESTS_LIMITS);
  gated = readGated();
  selected = selectRows(gated.rows, args);
  redisNeeded = selected.some((row) =>
    needsRedis(gated.stepEnv, readFileSync(join(root, 'packages', row.pkg, row.file), 'utf8')),
  );
} catch (error) {
  fail2(error.message);
}

const runId = randomBytes(4).toString('hex');
const names = []; // every container this run may have created, recorded before its docker run
let removed = false;
let current = null; // the running child
let signalled = null;
let cleaning = false;

class Aborted extends Error {}

const killGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (cleaning) return; // cleanup is already on its way out
    signalled ??= signal;
    if (current) killGroup(current, 'SIGKILL');
  });
}

// Runs a command in its own process group. A limit kills the whole group.
function run(command, commandArgs, { env = process.env, limitS, capture = false } = {}) {
  if (signalled && !cleaning) return Promise.reject(new Aborted());
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env,
      detached: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    current = child;
    let output = '';
    let stdout = '';
    if (capture) {
      child.stdout.on('data', (chunk) => {
        output += chunk;
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => (output += chunk));
    }
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGKILL');
    }, limitS * 1000);
    const settle = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child, 'SIGKILL');
      current = null;
      if (signalled && !cleaning) return resolve(Promise.reject(new Aborted()));
      resolve({ code, timedOut, output: error ? `${output}${error.message}\n` : output, stdout });
    };
    child.on('error', (error) => settle(null, error));
    child.on('close', (code) => settle(code));
  });
}

const docker = (dockerArgs, limitS = limits.dockerS) =>
  run('docker', dockerArgs, { capture: true, limitS });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(kind, service) {
  const name = `gated-tests-${runId}-${kind}`;
  names.push(name);
  const postgres = kind !== 'redis';
  const password = randomBytes(16).toString('hex');
  const user = service.env.POSTGRES_USER;
  const db = service.env.POSTGRES_DB;
  const runArgs = ['run', '-d', '--name', name, '-p', `127.0.0.1::${service.containerPort}`];
  // The password goes by name, so it stays out of the docker command line.
  if (postgres) runArgs.push('--env', `POSTGRES_USER=${user}`, '--env', 'POSTGRES_PASSWORD');
  if (postgres) runArgs.push('--env', `POSTGRES_DB=${db}`);
  runArgs.push(service.image);
  const created = await run('docker', runArgs, {
    env: { ...process.env, POSTGRES_PASSWORD: password },
    capture: true,
    limitS: limits.startS,
  });
  if (created.code !== 0) throw new Error(`docker run ${name} failed:\n${created.output}`);
  const published = await docker(['port', name, `${service.containerPort}/tcp`]);
  const line = published.stdout.split('\n').find((candidate) => candidate.startsWith('127.0.0.1:'));
  const port = published.code === 0 && line ? Number(line.slice('127.0.0.1:'.length)) : NaN;
  if (!(port > 0))
    throw new Error(`docker port ${name} gave no 127.0.0.1 port:\n${published.output}`);
  return { name, kind, port, user, password, db, postgres };
}

async function waitReady(server) {
  const deadline = Date.now() + limits.readyS * 1000;
  // pg_isready needs -h: without it the init-time server on the unix socket can answer first.
  const probe = server.postgres
    ? ['exec', server.name, 'pg_isready', '-h', '127.0.0.1', '-U', server.user, '-d', server.db]
    : ['exec', server.name, 'redis-cli', 'ping'];
  for (;;) {
    const left = Math.min(limits.dockerS, (deadline - Date.now()) / 1000);
    if (left <= 0) break;
    const result = await docker(probe, left);
    if (result.code === 0 && (server.postgres || result.stdout.trim() === 'PONG')) {
      if (server.postgres) return;
      const config = await docker([
        'exec',
        server.name,
        'redis-cli',
        'CONFIG',
        'SET',
        'maxmemory-policy',
        'noeviction',
      ]);
      if (config.code !== 0) throw new Error(`redis maxmemory-policy not set:\n${config.output}`);
      return;
    }
    await sleep(300);
  }
  const logs = await docker(['logs', '--tail', '20', server.name]);
  throw new Error(
    `${server.name} was not ready in ${limits.readyS}s; last log lines:\n${logs.output}`,
  );
}

let tmp = null;
let results = [];

async function cleanup() {
  cleaning = true;
  if (names.length > 0 && !removed) {
    const result = await docker(['rm', '-fv', ...names]).catch((error) => ({
      code: 1,
      output: error.message,
    }));
    if (result.code === 0 && !result.timedOut) removed = true;
    else
      console.error(
        `run-gated-tests: could not confirm these are removed (docker missing or its daemon down?): ${names.join(' ')}; if they exist run: docker rm -fv ${names.join(' ')}`,
      );
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

// A last resort for an exit that skipped the cleanup above.
process.on('exit', () => {
  if (current) killGroup(current, 'SIGKILL');
  if (names.length > 0 && !removed) {
    spawnSync('docker', ['rm', '-fv', ...names], {
      stdio: 'ignore',
      timeout: limits.dockerS * 1000,
    });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const portVar = (variable) => variable.replace(/_URL$/, '_PORT');

async function runRow(row, servers, baseEnv) {
  const server = servers[row.server === 'pgvector' ? 'pgvector' : 'postgres'];
  const url = `postgres://${server.user}:${server.password}@127.0.0.1:${server.port}/${row.db}`;
  const report = join(tmp, `${row.db}.json`);
  console.log(`== ${row.pkg} ${row.file} (${row.var}, database ${row.db} on ${row.server}) ==`);
  const probe = await docker([
    'exec',
    server.name,
    'psql',
    '-U',
    server.user,
    '-d',
    'postgres',
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${row.db}'`,
  ]);
  if (probe.code !== 0) {
    console.log(`database probe failed for ${row.file} (${row.db})\n${probe.output}`);
    return 'FAILED';
  }
  if (probe.stdout.trim() !== '1') {
    const created = await docker([
      'exec',
      server.name,
      'psql',
      '-U',
      server.user,
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE ${row.db}`,
    ]);
    if (created.code !== 0) {
      console.log(`could not create ${row.db}\n${created.output}`);
      return 'FAILED';
    }
  }
  const migrated = await run('pnpm', ['--filter', '@haive/database', 'migrate'], {
    env: { ...baseEnv, DATABASE_URL: url },
    capture: true,
    limitS: limits.migrateS,
  });
  if (migrated.code !== 0) {
    console.log(`migrate failed for ${row.db}\n${migrated.output}`);
    return migrated.timedOut ? 'TIMEOUT' : 'FAILED';
  }
  const rowEnv = { ...baseEnv, [row.var]: url };
  if (portVar(row.var) !== row.var) rowEnv[portVar(row.var)] = String(server.port);
  rmSync(report, { force: true }); // rows sharing a database share a report path
  const tested = await run(
    'pnpm',
    [
      '--filter',
      `@haive/${row.pkg}`,
      'exec',
      'vitest',
      'run',
      row.file,
      '--reporter=default',
      '--reporter=json',
      '--maxWorkers=2',
      `--outputFile.json=${report}`,
    ],
    { env: rowEnv, limitS: limits.rowS },
  );
  if (tested.timedOut) {
    console.log(`${row.file} hit its ${limits.rowS}s limit and was killed`);
    return 'TIMEOUT';
  }
  if (tested.code === null && tested.output) console.log(tested.output);
  let verdict = null;
  try {
    verdict = completeness(JSON.parse(readFileSync(report, 'utf8')));
    console.log(`${row.file}: ${verdict.line}`);
  } catch {
    console.log(`${row.file}: no test report`);
  }
  if (tested.code !== 0) return 'FAILED';
  if (!verdict?.ok) {
    console.log(`${row.file} did not run in full`);
    return 'INCOMPLETE';
  }
  return 'passed';
}

let exitCode = 1;
try {
  tmp = mkdtempSync(join(tmpdir(), 'gated-tests-'));
  const wanted = new Set(
    selected.map((row) => (row.server === 'pgvector' ? 'pgvector' : 'postgres')),
  );
  const servers = {};
  for (const kind of ['postgres', 'pgvector']) {
    if (wanted.has(kind)) servers[kind] = await start(kind, gated.services[kind]);
  }
  if (redisNeeded) servers.redis = await start('redis', gated.services.redis);
  for (const server of Object.values(servers)) {
    await waitReady(server);
    const { image } = gated.services[server.kind];
    console.log(`run-gated-tests: ${server.name} (${image}) on 127.0.0.1:${server.port}`);
  }

  const strip = new Set([
    ...Object.keys(gated.jobEnv),
    ...Object.keys(gated.stepEnv),
    ...gated.rows.map((row) => row.var),
  ]);
  const running = {};
  for (const [kind, server] of Object.entries(servers)) {
    running[kind] = { port: server.port, user: server.user, password: server.password };
  }
  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !strip.has(name))),
    ...rewriteEnv({ ...gated.jobEnv, ...gated.stepEnv }, gated.services, running),
  };

  let setupOk = true;
  if (servers.postgres) {
    // The CI setup step: migrate the job's own database once.
    const setup = await run('pnpm', ['--filter', '@haive/database', 'migrate'], {
      env: baseEnv,
      capture: true,
      limitS: limits.migrateS,
    });
    if (setup.code !== 0) {
      console.log(`migrating the job database failed\n${setup.output}`);
      setupOk = false;
    }
  }
  if (setupOk) {
    for (const row of selected) {
      const began = performance.now();
      const status = await runRow(row, servers, baseEnv);
      results.push({ row, status, seconds: (performance.now() - began) / 1000 });
    }
  }
  const bad = results.filter((result) => result.status !== 'passed');
  console.log('run-gated-tests: summary');
  for (const { row, status, seconds } of results) {
    console.log(`  ${status} ${seconds.toFixed(1)}s ${row.pkg} ${row.file}`);
  }
  console.log(
    !setupOk
      ? 'run-gated-tests: setup failed, no row ran'
      : bad.length > 0
        ? `run-gated-tests: ${bad.length} of ${results.length} rows did not pass`
        : `run-gated-tests: all ${results.length} rows passed`,
  );
  exitCode = setupOk && bad.length === 0 ? 0 : 1;
} catch (error) {
  if (!(error instanceof Aborted)) console.error(`run-gated-tests: ${error.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(signalled ? 128 + constants.signals[signalled] : exitCode);
