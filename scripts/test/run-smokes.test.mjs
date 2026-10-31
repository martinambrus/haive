import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = join(root, 'scripts', 'run-smokes.mjs');
const LONG = { timeout: 60_000 };

// The fake smokes run in the fixture dir: ran.txt lists what started, and every *.pid file names a
// process the test must find dead once the runner is done. The sources avoid template literals so
// that each can sit inside one.
const HELPERS = {
  // node mark.mjs NAME [EXIT]
  'mark.mjs': `
import { appendFileSync } from 'node:fs';
appendFileSync('ran.txt', process.argv[2] + '\\n');
process.exit(Number(process.argv[3] ?? 0));
`,
  // node hang.mjs NAME [stubborn]: starts a grandchild, then idles forever. A stubborn one and its
  // grandchild ignore SIGTERM.
  'hang.mjs': `
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const [name, mode] = process.argv.slice(2);
const stubborn = mode === 'stubborn';
if (stubborn) process.on('SIGTERM', () => {});
const grandchild = stubborn
  ? spawn('sh', ['-c', 'trap "" TERM; exec sleep 300'], { stdio: 'ignore' })
  : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
appendFileSync('ran.txt', name + '\\n');
writeFileSync(name + '.pid', String(process.pid));
writeFileSync(name + '-grandchild.pid', String(grandchild.pid));
writeFileSync(name + '.ready', '');
setInterval(() => {}, 1000);
`,
  // node straggle.mjs: leaves a process running behind it and fails
  'straggle.mjs': `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const straggler = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('straggler.pid', String(straggler.pid));
process.exit(3);
`,
};

// A stand-in for pnpm, first on PATH, that ignores every signal and logs the ones it gets. Only
// SIGKILL can end it, which is what the real pnpm cannot show: it exits on a second SIGINT.
const STUBBORN_PNPM = `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => appendFileSync('signals.txt', signal + '\\n'));
}
appendFileSync('ran.txt', process.argv.slice(2).join(' ') + '\\n');
writeFileSync('stubborn.pid', String(process.pid));
writeFileSync('stubborn.ready', '');
setInterval(() => {}, 1000);
`;

const pass = (name) => `node mark.mjs ${name}`;
const fail = (name, code) => `node mark.mjs ${name} ${code}`;
const hang = (name, mode = '') => `node hang.mjs ${name} ${mode}`.trim();

// A zombie still answers kill(pid, 0), so liveness is read from the state field of /proc/PID/stat.
const alive = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !'ZX'.includes(stat[stat.lastIndexOf(')') + 2]);
  } catch {
    return false;
  }
};

const pidsIn = (dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith('.pid'))
    .map((file) => Number(readFileSync(join(dir, file), 'utf8')));

// A package of fake smokes in a temp dir. A failing run must leave nothing behind, so the cleanup
// kills every pid the smokes recorded that is still alive.
const fixture = (t, scripts) => {
  const dir = mkdtempSync(join(tmpdir(), 'haive-run-smokes-'));
  t.after(() => {
    for (const pid of pidsIn(dir).filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, scripts }),
  );
  for (const [file, source] of Object.entries(HELPERS)) writeFileSync(join(dir, file), source);
  return dir;
};

// The runner's output goes to a file, not a pipe: a survivor would hold a pipe open and keep
// spawnSync waiting for it after the runner itself had exited. GITHUB_ACTIONS is blanked so that a
// failing fixture smoke does not annotate the job that runs this test.
const runnerEnv = (extra) => ({ ...process.env, GITHUB_ACTIONS: '', ...extra });

const run = (dir, args, extra = {}) => {
  const log = join(dir, 'runner.log');
  const fd = openSync(log, 'w');
  const began = Date.now();
  const out = spawnSync(process.execPath, [runner, ...args], {
    cwd: dir,
    env: runnerEnv(extra),
    stdio: ['ignore', fd, fd],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  closeSync(fd);
  const output = readFileSync(log, 'utf8');
  return {
    status: out.status,
    ms: Date.now() - began,
    output,
    note: `exit ${out.status}, signal ${out.signal}\n${output}`,
  };
};

const start = (t, dir, args, extra = {}) => {
  const log = join(dir, 'runner.log');
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [runner, ...args], {
    cwd: dir,
    env: runnerEnv(extra),
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, output: () => readFileSync(log, 'utf8') };
};

const until = async (condition) => {
  for (let i = 0; i < 600 && !condition(); i += 1) await sleep(50);
};

const finished = ({ child }) => child.exitCode !== null || child.signalCode !== null;

// Resolves once the smoke has recorded its pids and idles, or the runner has already gone.
const running = async (dir, started, name) => {
  const ready = join(dir, `${name}.ready`);
  await until(() => existsSync(ready) || finished(started));
  assert.ok(existsSync(ready), `${name} never started\n${started.output()}`);
};

// The pids a hung or failed smoke recorded that are still alive after a grace period for the kill
// to land. An empty answer means nothing only when the smoke did record its pids.
const survivors = async (dir, expected) => {
  const pids = pidsIn(dir);
  assert.equal(pids.length, expected, 'the smoke did not record its pids');
  for (let i = 0; i < 30 && pids.some(alive); i += 1) await sleep(100);
  return pids.filter(alive);
};

const ran = (dir) => {
  const file = join(dir, 'ran.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

const summaryLine = (status, name) => new RegExp(`^ +${status} +\\d+\\.\\ds ${name}$`, 'm');

describe('run-smokes', () => {
  it('a: runs every smoke in the given order and exits 0', LONG, (t) => {
    const names = ['smoke:one', 'smoke:two', 'smoke:three'];
    const dir = fixture(t, Object.fromEntries(names.map((name) => [name, pass(name)])));
    const r = run(dir, names);
    assert.equal(r.status, 0, r.note);
    assert.deepEqual(ran(dir), names);
    for (const name of names) assert.match(r.output, summaryLine('ok', name), r.note);
    assert.match(r.output, /all 3 smokes passed/, r.note);
  });

  it('b: kills a hung smoke and what it started, names it, and runs the rest', LONG, async (t) => {
    const dir = fixture(t, {
      'smoke:one': pass('smoke:one'),
      'smoke:hang': hang('smoke:hang'),
      'smoke:two': pass('smoke:two'),
    });
    const r = run(dir, ['smoke:one', 'smoke:hang=5', 'smoke:two']);
    assert.equal(r.status, 1, r.note);
    assert.match(r.output, /smoke:hang \(limit 5s\)/, r.note);
    assert.match(r.output, /smoke:hang hit its 5s limit/, r.note);
    assert.match(r.output, summaryLine('TIMEOUT', 'smoke:hang'), r.note);
    assert.deepEqual(ran(dir), ['smoke:one', 'smoke:hang', 'smoke:two']);
    assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
    assert.deepEqual(await survivors(dir, 2), []);
  });

  it('c: goes on after a failed smoke and exits 1', LONG, (t) => {
    const dir = fixture(t, {
      'smoke:one': pass('smoke:one'),
      'smoke:bad': fail('smoke:bad', 3),
      'smoke:two': pass('smoke:two'),
    });
    const r = run(dir, ['smoke:one', 'smoke:bad', 'smoke:two']);
    assert.equal(r.status, 1, r.note);
    assert.deepEqual(ran(dir), ['smoke:one', 'smoke:bad', 'smoke:two']);
    assert.match(r.output, /smoke:bad failed \(exit 3\)/, r.note);
    assert.match(r.output, summaryLine('FAILED', 'smoke:bad'), r.note);
    assert.match(r.output, /1 of 3 smokes did not pass: smoke:bad/, r.note);
  });

  it('d: kills a hung smoke that ignores SIGTERM', LONG, async (t) => {
    const dir = fixture(t, { 'smoke:stubborn': hang('smoke:stubborn', 'stubborn') });
    const r = run(dir, ['smoke:stubborn=5']);
    assert.equal(r.status, 1, r.note);
    assert.match(r.output, summaryLine('TIMEOUT', 'smoke:stubborn'), r.note);
    assert.deepEqual(await survivors(dir, 2), []);
  });

  it('e: counts an unknown script as failed and goes on', LONG, (t) => {
    const dir = fixture(t, { 'smoke:one': pass('smoke:one'), 'smoke:two': pass('smoke:two') });
    const r = run(dir, ['smoke:one', 'smoke:missing', 'smoke:two']);
    assert.equal(r.status, 1, r.note);
    assert.deepEqual(ran(dir), ['smoke:one', 'smoke:two']);
    assert.match(r.output, summaryLine('FAILED', 'smoke:missing'), r.note);
  });

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ]) {
    it(`f: ${signal} to the runner: no further smoke, exits ${code}`, LONG, async (t) => {
      const dir = fixture(t, { 'smoke:hang': hang('smoke:hang'), 'smoke:two': pass('smoke:two') });
      const started = start(t, dir, ['smoke:hang', 'smoke:two']);
      await running(dir, started, 'smoke:hang');
      started.child.kill(signal);
      assert.deepEqual(await started.exited, { code, signal: null }, started.output());
      assert.deepEqual(await survivors(dir, 2), []);
      assert.deepEqual(ran(dir), ['smoke:hang']);
    });
  }

  it('f: a second signal kills a smoke that ignored the first', LONG, async (t) => {
    const dir = fixture(t, {});
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'pnpm'), STUBBORN_PNPM, { mode: 0o755 });
    const started = start(t, dir, ['smoke:stubborn', 'smoke:two'], {
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
    });
    await running(dir, started, 'stubborn');
    const seen = () =>
      existsSync(join(dir, 'signals.txt')) ? readFileSync(join(dir, 'signals.txt'), 'utf8') : '';
    started.child.kill('SIGINT');
    await until(() => seen().includes('\n') || finished(started));
    assert.equal(seen(), 'SIGINT\n', 'the smoke must get the same signal');
    started.child.kill('SIGTERM');
    assert.deepEqual(await started.exited, { code: 130, signal: null }, started.output());
    assert.deepEqual(await survivors(dir, 1), []);
    assert.deepEqual(ran(dir), ['run smoke:stubborn']);
  });

  for (const args of [
    [],
    ['smoke:a=abc'],
    ['smoke:a=0'],
    ['smoke:a='],
    ['smoke:a=-3'],
    ['smoke:a=1.5'],
    ['=5'],
    ['smoke:a', 'smoke:b=abc'],
  ]) {
    it(`g: ${JSON.stringify(args)} is a usage error and runs nothing`, LONG, (t) => {
      const dir = fixture(t, { 'smoke:a': pass('smoke:a'), 'smoke:b': pass('smoke:b') });
      const r = run(dir, args);
      assert.equal(r.status, 2, r.note);
      assert.match(
        r.output,
        /run-smokes: usage: node scripts\/run-smokes\.mjs name\[=seconds\]/,
        r.note,
      );
      assert.deepEqual(ran(dir), []);
    });
  }

  it('i: counts a smoke pnpm cannot start as failed and goes on', LONG, (t) => {
    const dir = fixture(t, { 'smoke:one': pass('smoke:one'), 'smoke:two': pass('smoke:two') });
    const r = run(dir, ['smoke:one', 'smoke:two'], { PATH: '/nonexistent' });
    assert.equal(r.status, 1, r.note);
    for (const name of ['smoke:one', 'smoke:two']) {
      assert.match(r.output, summaryLine('FAILED', name), r.note);
      assert.equal(r.output.split(`${name} failed`).length, 2, `${name} must fail once\n${r.note}`);
    }
    assert.deepEqual(ran(dir), []);
  });

  it('j: prints a failure as a GitHub annotation only under GitHub Actions', LONG, (t) => {
    const dir = fixture(t, { 'smoke:bad': fail('smoke:bad', 3) });
    const plain = run(dir, ['smoke:bad']);
    assert.match(plain.output, /^run-smokes: smoke:bad failed \(exit 3\)$/m, plain.note);
    assert.doesNotMatch(plain.output, /::error::/, plain.note);
    const annotated = run(dir, ['smoke:bad'], { GITHUB_ACTIONS: 'true' });
    assert.match(
      annotated.output,
      /^::error::run-smokes: smoke:bad failed \(exit 3\)$/m,
      annotated.note,
    );
  });

  it('k: kills what a failed smoke left running', LONG, async (t) => {
    const dir = fixture(t, { 'smoke:bad': 'node straggle.mjs' });
    const r = run(dir, ['smoke:bad']);
    assert.equal(r.status, 1, r.note);
    assert.deepEqual(await survivors(dir, 1), []);
  });
});

describe('smoke:ci in packages/*/package.json', () => {
  it('h: smokes go through the runner, each a script of the package, none twice', LONG, () => {
    const prefix = 'node ../../scripts/run-smokes.mjs ';
    let wired = 0;
    for (const pkg of readdirSync(join(root, 'packages'))) {
      const file = join(root, 'packages', pkg, 'package.json');
      if (!existsSync(file)) continue;
      const { scripts = {} } = JSON.parse(readFileSync(file, 'utf8'));
      const ci = scripts['smoke:ci'];
      if (ci === undefined) continue;
      wired += 1;
      assert.ok(ci.startsWith(prefix), `${pkg}: smoke:ci must start with "${prefix}"`);
      assert.ok(!ci.includes('&&'), `${pkg}: smoke:ci must not chain with &&`);
      const names = ci
        .slice(prefix.length)
        .split(/\s+/)
        .filter(Boolean)
        .map((spec) => {
          const [name, seconds, ...extra] = spec.split('=');
          assert.ok(Object.hasOwn(scripts, name), `${pkg}: ${name} is not a script of the package`);
          assert.equal(extra.length, 0, `${pkg}: ${spec}`);
          if (seconds !== undefined) assert.match(seconds, /^[1-9]\d*$/, `${pkg}: ${spec}`);
          return name;
        });
      assert.ok(names.length > 0, `${pkg}: smoke:ci names no smoke`);
      assert.deepEqual(
        names.filter((name, i) => names.indexOf(name) !== i),
        [],
        `${pkg}: smokes named twice`,
      );
    }
    assert.ok(wired > 0, 'no package defines smoke:ci');
  });
});
