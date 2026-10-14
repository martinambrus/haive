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
case "$1" in
  volume)
    case " $STUB_VOLUMES_ABSENT " in
      *" $3 "*) echo "no such volume: $3" >&2; exit 1 ;;
    esac
    if [ "$2" = rm ] && [ "$3" = "$STUB_VOLUME_HELD" ]; then
      echo "volume $3 is in use" >&2
      exit 1
    fi ;;
  ps)
    if [ -n "$STUB_VOLUME_HELD" ]; then
      case "$*" in *"volume=$STUB_VOLUME_HELD"*) printf '%s\\n' $STUB_VOLUME_HOLDERS ;; esac
    fi ;;
  compose)
    shift
    while [ "$1" = -f ]; do shift 2; done
    if [ "$1" = build ] && [ -n "$STUB_DOCKER_BUILD_FAILS" ]; then exit 1; fi
    if [ "$1" = run ] && [ -n "$STUB_DOCKER_RUN_FAILS" ]; then exit 1; fi ;;
esac
exit 0
`;

const GPU_STUBS = {
  'nvidia-smi': '#!/bin/sh\necho "GPU 0: Stub Card (UUID: GPU-0)"\n',
  sleep: '#!/bin/sh\n', // has_nvidia_runtime waits a second between its three probes
};

const PROJECT = 'proj';
const volume = (name) => `${PROJECT}_${name}`;

// dev.sh asks whether a volume exists before it removes it.
const removals = (count) =>
  Array.from({ length: count }, () => ['volume inspect', 'volume rm']).flat();
const steps = (volumes, after) => ['build', 'rm', ...removals(volumes), ...after];

// [args, volumes dev.sh removes, the first of them, the calls after the removals]
const CASES = [
  [['rebuild'], 7, 'haive_node_modules_root', ['up']],
  [['rebuild', 'api'], 1, 'haive_node_modules_api', ['up']],
  [['rebuild', 'web'], 2, 'haive_node_modules_web', ['up']],
  [['rebuild', 'api', 'web'], 3, 'haive_node_modules_api', ['up']],
  [['reset'], 7, 'haive_node_modules_root', ['run', 'up']],
];

// "compose -f a.yml -f b.yml rm -fs api" -> "rm"; "volume rm v1" -> "volume rm"; "ps -a" -> "ps"
const kind = (call) => {
  const [first, second] = call.replace(/^compose( -f \S+)+/, 'compose').split(' ');
  if (first === 'compose') return second;
  return first === 'volume' ? `${first} ${second}` : first;
};

// HAIVE_GPU=cpu skips dev.sh's GPU probes, so the host's card cannot change the path it takes.
const run = (t, args, { buildFails = false, gpu = false, stub = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'haive-dev-sh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), DOCKER_STUB, { mode: 0o755 });
  if (gpu) {
    for (const [name, body] of Object.entries(GPU_STUBS)) {
      writeFileSync(join(dir, name), body, { mode: 0o755 });
    }
  }
  const out = spawnSync('bash', [devScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      DOCKER_HOST: 'unix:///nonexistent', // a docker that slips past the stub finds no daemon
      COMPOSE_PROJECT_NAME: PROJECT,
      HAIVE_GPU: gpu ? 'auto' : 'cpu',
      STUB_DOCKER_LOG: log,
      STUB_DOCKER_BUILD_FAILS: buildFails ? '1' : '',
      ...stub,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(kind) : [];
  return { out, calls };
};

describe('dev.sh builds before it tears anything down', () => {
  for (const [args, volumes, , after] of CASES) {
    const name = args.join(' ');

    it(`${name}: a failed build removes and starts nothing`, (t) => {
      const { out, calls } = run(t, args, { buildFails: true });
      assert.notEqual(out.status, 0, out.stdout);
      assert.deepEqual(calls, ['build']);
    });

    it(`${name}: builds first, removes after, brings the stack up last`, (t) => {
      const { out, calls } = run(t, args);
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.deepEqual(calls, steps(volumes, after));
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

describe('dev.sh does not report a teardown it could not finish as a success', () => {
  for (const [args, volumes, first] of CASES) {
    const name = args.join(' ');

    it(`${name}: a volume that does not exist is not an error`, (t) => {
      const { out, calls } = run(t, args, { stub: { STUB_VOLUMES_ABSENT: volume(first) } });
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.equal(calls.at(-1), 'up');
    });

    it(`${name}: a volume it cannot remove fails the run after the stack is up, naming its holders`, (t) => {
      const held = volume(first);
      const stub = { STUB_VOLUME_HELD: held, STUB_VOLUME_HOLDERS: 'proj-api-1 proj-run-7' };
      const { out, calls } = run(t, args, { stub });
      assert.notEqual(out.status, 0, out.stdout);
      assert.equal(calls.at(-1), 'up');
      assert.equal(calls.filter((call) => call === 'volume rm').length, volumes);
      const line = out.stdout.split('\n').find((l) => l.includes(held));
      assert.ok(line, out.stdout);
      assert.match(line, /proj-api-1/);
      assert.match(line, /proj-run-7/);
    });
  }

  it('reset: a failed dist wipe still brings the stack up, then fails naming the wipe', (t) => {
    const { out, calls } = run(t, ['reset'], { stub: { STUB_DOCKER_RUN_FAILS: '1' } });
    assert.notEqual(out.status, 0, out.stdout);
    assert.equal(calls.at(-1), 'up');
    assert.match(out.stdout, /wipe/);
  });
});

describe('dev.sh refuses to start when nvidia-smi sees a card but docker has no nvidia runtime', () => {
  for (const args of [['up'], ['restart'], ['rebuild'], ['rebuild', 'api'], ['reset']]) {
    it(`${args.join(' ')}: exits 1 after three probes, before it removes or starts anything`, (t) => {
      const { out, calls } = run(t, args, { gpu: true });
      assert.equal(out.status, 1, out.stdout + out.stderr);
      assert.match(out.stdout, /REFUSING TO START/);
      assert.deepEqual(calls, ['info', 'info', 'info']);
    });
  }
});
