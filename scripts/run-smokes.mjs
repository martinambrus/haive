// Runs package scripts one after another, each under its own time limit. A smoke that hangs is
// killed with everything it started and named in the output; the smokes after it still run.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// Across 8 green main runs, 50 of the 52 smokes never took longer than 17 s. The other two,
// repo-refresh (270 s) and two-install (81 s), carry their own limit in package.json. A hung
// smoke costs its whole limit, which has to stay inside the ~350 s that the job's 1800 s leave
// over a normal run.
const DEFAULT_LIMIT_S = 120;

const usage = (reason) => {
  console.error('run-smokes: usage: node scripts/run-smokes.mjs name[=seconds] ...');
  console.error(`run-smokes: ${reason}`);
  process.exit(2);
};

// Under GitHub Actions an error line becomes an annotation; elsewhere it is plain text.
const report = (message) =>
  console.log(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}run-smokes: ${message}`);

const specs = process.argv.slice(2).map((arg) => {
  const match = /^([^=]+)(?:=([1-9]\d*))?$/.exec(arg);
  if (!match) usage(`"${arg}" is not name or name=seconds, with seconds a positive integer`);
  return { name: match[1], limit: Number(match[2] ?? DEFAULT_LIMIT_S) };
});
if (specs.length === 0) usage('no smoke given');

let current = null; // the running smoke
let signalled = null; // the first signal the runner received

// A smoke leads its own process group, so one signal reaches pnpm, the script and everything the
// script started. Signalling the pid alone would leave the script and its children running.
const killGroup = (child, signal) => {
  if (child.pid === undefined) return; // the spawn failed, so there is no group
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

// A detached group no longer receives the terminal's Ctrl-C, so the runner passes signals on.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    const again = signalled !== null;
    signalled ??= signal;
    if (current) killGroup(current, again ? 'SIGKILL' : signal);
  });
}

const run = ({ name, limit }) =>
  new Promise((resolve) => {
    const child = spawn('pnpm', ['run', name], { stdio: 'inherit', detached: true });
    current = child;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      report(`${name} hit its ${limit}s limit and was killed`);
      killGroup(child, 'SIGKILL');
    }, limit * 1000);
    // Whatever the outcome, nothing the smoke started may outlive it into the next one.
    const settle = (status, message) => {
      if (settled) return; // a spawn error and the close that follows it both end up here
      settled = true;
      clearTimeout(timer);
      killGroup(child, 'SIGKILL');
      current = null;
      if (message) report(message);
      resolve(status);
    };
    child.on('error', (error) => settle('FAILED', `${name} failed (${error.message})`));
    child.on('close', (code, signal) => {
      if (timedOut) settle('TIMEOUT');
      else if (code === 0) settle('ok');
      else settle('FAILED', `${name} failed (${signal ? `signal ${signal}` : `exit ${code}`})`);
    });
  });

const results = [];
for (const spec of specs) {
  if (signalled) break;
  console.log(`run-smokes: ${spec.name} (limit ${spec.limit}s)`);
  const began = performance.now();
  const status = await run(spec);
  results.push({ name: spec.name, status, seconds: (performance.now() - began) / 1000 });
}

const bad = results.filter((result) => result.status !== 'ok');
console.log('run-smokes: summary');
for (const { name, status, seconds } of results) {
  console.log(`  ${status} ${seconds.toFixed(1)}s ${name}`);
}
console.log(
  bad.length > 0
    ? `run-smokes: ${bad.length} of ${results.length} smokes did not pass: ${bad.map((result) => result.name).join(', ')}`
    : `run-smokes: all ${results.length} smokes passed`,
);
process.exit(signalled ? 128 + constants.signals[signalled] : bad.length > 0 ? 1 : 0);
