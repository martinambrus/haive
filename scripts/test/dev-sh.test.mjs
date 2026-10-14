import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const devScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev.sh');

// dev.sh finds this `docker` first on PATH, so the real daemon and the dev stack are never reached.
const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DOCKER_LOG"
if [ "$1" = compose ]; then
  shift
  while [ "$1" = -f ]; do shift 2; done
  if [ "$1" = build ] && [ -n "$STUB_DOCKER_BUILD_FAILS" ]; then exit 1; fi
fi
exit 0
`;

const REBUILD = ['build', 'rm', 'volume rm', 'up'];
const RESET = ['build', 'rm', 'volume rm', 'run', 'up'];
const CASES = [
  [['rebuild'], REBUILD],
  [['rebuild', 'api'], REBUILD],
  [['rebuild', 'web'], REBUILD],
  [['rebuild', 'api', 'web'], REBUILD],
  [['reset'], RESET],
];

// "compose -f a.yml -f b.yml rm -fs api" -> "rm"; "volume rm v1 v2" -> "volume rm"
const kind = (call) => {
  const [first, second] = call.replace(/^compose( -f \S+)+/, 'compose').split(' ');
  return first === 'compose' ? second : `${first} ${second}`;
};

// HAIVE_GPU=cpu skips dev.sh's GPU probes, so the host's card cannot change the path it takes.
const run = (t, args, { buildFails = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'haive-dev-sh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), DOCKER_STUB, { mode: 0o755 });
  const out = spawnSync('bash', [devScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      DOCKER_HOST: 'unix:///nonexistent', // a docker that slips past the stub finds no daemon
      HAIVE_GPU: 'cpu',
      STUB_DOCKER_LOG: log,
      STUB_DOCKER_BUILD_FAILS: buildFails ? '1' : '',
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(kind) : [];
  return { out, calls };
};

describe('dev.sh builds before it tears anything down', () => {
  for (const [args, steps] of CASES) {
    const name = args.join(' ');

    it(`${name}: a failed build removes and starts nothing`, (t) => {
      const { out, calls } = run(t, args, { buildFails: true });
      assert.notEqual(out.status, 0, out.stdout);
      assert.deepEqual(calls, ['build']);
    });

    it(`${name}: builds first, removes after, brings the stack up last`, (t) => {
      const { out, calls } = run(t, args);
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.deepEqual(calls, steps);
    });
  }
});

describe('dev.sh rebuild with a service it does not know', () => {
  it('refuses before any docker call, even next to a known one', (t) => {
    const { out, calls } = run(t, ['rebuild', 'api', 'nope']);
    assert.notEqual(out.status, 0, out.stdout);
    assert.deepEqual(calls, []);
  });
});
