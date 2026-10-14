import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'install',
  'install.ps1',
);

const IMAGE = 'mcr.microsoft.com/powershell:lts-7.4-alpine-3.20';
const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const succeeds = (command, args) => spawnSync(command, args, { encoding: 'utf8' }).status === 0;

// PowerShell 7 on this machine if there is one, else the pinned image when it is already pulled.
const HOST_PWSH = succeeds('pwsh', ['-NoProfile', '-Command', 'exit 0']);
const SKIP =
  process.platform === 'win32'
    ? 'the stub docker is a sh script'
    : !HOST_PWSH && !succeeds('docker', ['image', 'inspect', IMAGE])
      ? `pwsh is not on PATH and ${IMAGE} is not pulled`
      : false;

// install.ps1 cannot run off Windows, so the script it writes is cut out of its $uninstall here-string.
const generatedUninstall = () => {
  const source = readFileSync(installer, 'utf8');
  const open = "$uninstall = @'\n";
  const start = source.indexOf(open) + open.length;
  const end = source.indexOf("\n'@\n", start);
  assert.ok(start > open.length && end > start, 'the $uninstall here-string is not where it was');
  return source.slice(start, end);
};

// The same stub as uninstall-sh.test.mjs: what exists is the STUB_* lists minus what a call removed.
const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STUB_DOCKER_LOG"
S=\${STUB_STATE:-/nonexistent}
if [ -n "$STUB_DAEMON_DOWN" ] || [ -e "$S/dead" ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2
  exit 1
fi
[ "$*" = "$STUB_DIES_AFTER" ] && : > "$S/dead"
has() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }
gone() { grep -qxF -- "$1 $2" "$S/removed" 2>/dev/null; }
drop() { echo "$1 $2" >> "$S/removed"; }
live() { for x in $2; do case "$x" in "$3"*) gone "$1" "$x" || echo "$x" ;; esac; done; }
prefix() { for a in "$@"; do case "$a" in name=^*) echo "\${a#name=^}" ;; esac; done; }
last() { for a in "$@"; do l=$a; done; echo "$l"; }
case "$1" in
  compose)
    case " $* " in
      *" down "*)
        if [ -n "$STUB_DOWN_FAILS" ]; then echo "error while removing network: resource is still in use" >&2; exit 1; fi
        for c in $STUB_PROJECT_CONTAINERS; do drop container "$c"; done ;;
    esac ;;
  ps)
    p=$(prefix "$@")
    if [ -n "$p" ]; then live container "$STUB_CONTAINERS" "$p"; fi
    for a in "$@"; do
      case "$a" in
        volume=*) if has "$STUB_VOLUMES_HELD" "\${a#volume=}"; then for h in $STUB_HOLDERS; do echo "$h"; done; fi ;;
        label=com.docker.compose.project=*)
          if [ "\${a#label=com.docker.compose.project=}" = "$STUB_PROJECT" ]; then live container "$STUB_PROJECT_CONTAINERS" ""; fi ;;
      esac
    done ;;
  rm)
    c=$(last "$@")
    if has "$STUB_CONTAINERS_STUCK" "$c"; then echo "Error response from daemon: cannot remove container $c" >&2; exit 1; fi
    drop container "$c" ;;
  volume)
    case "$2" in
      ls) live volume "$STUB_VOLUMES" "$(prefix "$@")" ;;
      inspect | rm)
        if ! has "$STUB_VOLUMES" "$3" || gone volume "$3"; then echo "no such volume: $3" >&2; exit 1; fi
        if [ "$2" = rm ]; then
          if has "$STUB_VOLUMES_HELD" "$3"; then echo "volume $3 is in use" >&2; exit 1; fi
          drop volume "$3"
        fi ;;
    esac ;;
  network)
    case "$2" in
      ls) live network "$STUB_NETWORKS" "$(prefix "$@")" ;;
      inspect) case "$*" in *Containers*) echo "$STUB_HOLDERS" ;; *) echo "$3" ;; esac ;;
      rm)
        if has "$STUB_NETWORKS_HELD" "$3"; then echo "network $3 has active endpoints" >&2; exit 1; fi
        drop network "$3" ;;
    esac ;;
  images)
    repo=; template=
    for a in "$@"; do
      if [ -n "$template" ]; then template=; continue; fi
      case "$a" in images | -q) ;; --format) template=1 ;; *) repo=$a ;; esac
    done
    for i in $STUB_IMAGES; do
      if gone image "$i"; then continue; fi
      if [ -n "$repo" ] && [ "\${i%:*}" != "$repo" ]; then continue; fi
      echo "$i"
    done ;;
  rmi)
    i=$(last "$@")
    if has "$STUB_IMAGES_STUCK" "$i"; then echo "Error response from daemon: conflict: unable to delete $i" >&2; exit 1; fi
    drop image "$i" ;;
esac
exit 0
`;

const ID = 'unit';
const OTHER_PROJECT = 'other';
const HOLDERS = ['ext-pg', 'ext-shell'];
const RUNTIME = ['postgres_data', 'redis_data', 'mailpit_data', 'ollama_data'].map(
  (name) => `${ID}_${name}`,
);
const WORK = [
  'repos',
  'bundles',
  'wrappers',
  'squid_configs',
  'ddev_ca',
  'npm_cache',
  'ddev_registry_cache',
].map((name) => `${ID}_${name}`);
const PER_TASK = [`${ID}_cli_auth_t1`, `${ID}_ide_t1`];
const ALL = [...RUNTIME, ...WORK, ...PER_TASK];

const NETWORKS = ['network', 'sandbox', 'models'].map((name) => `${ID}-${name}`);
const PROJECT_CONTAINERS = [`${ID}-api`, `${ID}-worker`];
const STRAY = `${ID}-sandbox-t1`;
const IMAGES = [`${ID}-cli-sandbox:latest`, `${ID}-env-app:1`];

// A whole install: what every run starts from unless a case says otherwise.
const FIXTURE = {
  STUB_PROJECT: ID,
  STUB_VOLUMES: ALL.join(' '),
  STUB_NETWORKS: NETWORKS.join(' '),
  STUB_CONTAINERS: [...PROJECT_CONTAINERS, STRAY].join(' '),
  STUB_PROJECT_CONTAINERS: PROJECT_CONTAINERS.join(' '),
  STUB_IMAGES: IMAGES.join(' '),
};

const HELD_NETWORK = { STUB_NETWORKS_HELD: NETWORKS[0], STUB_HOLDERS: 'ext-pg' };

const GONE = /(Everything this install owned|The stack) is gone/;

describe('the uninstall.ps1 that install.ps1 writes', { skip: SKIP }, () => {
  let root;
  let dir;
  let otherProjectDir;
  let bin;
  let runs = 0;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'haive-uninstall-ps1-'));
    bin = join(root, 'bin');
    dir = join(root, 'install');
    mkdirSync(bin);
    mkdirSync(dir);
    writeFileSync(join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
    writeFileSync(join(dir, '.env'), `HAIVE_INSTALL_ID=${ID}\nCOMPOSE_PROJECT_NAME=${ID}\n`);
    writeFileSync(join(dir, 'uninstall.ps1'), generatedUninstall());
    otherProjectDir = join(root, 'install-other-project');
    mkdirSync(otherProjectDir);
    writeFileSync(
      join(otherProjectDir, '.env'),
      `HAIVE_INSTALL_ID=${ID}\nCOMPOSE_PROJECT_NAME=${OTHER_PROJECT}\n`,
    );
    copyFileSync(join(dir, 'uninstall.ps1'), join(otherProjectDir, 'uninstall.ps1'));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const pwsh = (args, stub, where) => {
    const script = [join(where, 'uninstall.ps1'), ...args];
    if (HOST_PWSH) {
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...stub };
      return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', ...script], {
        cwd: where,
        encoding: 'utf8',
        env,
      });
    }
    const inContainer = { PATH: `${bin}:${IMAGE_PATH}`, HOME: '/tmp', ...stub };
    const flags = Object.entries(inContainer).flatMap(([name, value]) => [
      '-e',
      `${name}=${value}`,
    ]);
    return spawnSync(
      'docker',
      [
        ...['run', '--rm', '--pull', 'never', '--network', 'none'],
        ...['--user', `${process.getuid()}:${process.getgid()}`, '-v', `${root}:${root}`],
        ...['-w', where, '-e', 'POWERSHELL_TELEMETRY_OPTOUT=1', '-e', 'POWERSHELL_UPDATECHECK=Off'],
        ...['-e', 'PSModuleAnalysisCachePath=/tmp/psmodulecache', ...flags],
        ...[IMAGE, 'pwsh', '-NoProfile', '-NonInteractive', '-File', ...script],
      ],
      { encoding: 'utf8' },
    );
  };

  const run = (args, stub = {}, where = dir) => {
    const n = ++runs;
    const log = join(root, `run-${n}.log`);
    const state = join(root, `state-${n}`);
    mkdirSync(state);
    const out = pwsh(args, { STUB_DOCKER_LOG: log, STUB_STATE: state, ...FIXTURE, ...stub }, where);
    const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);
    return { out, calls: lines(log), removed: lines(join(state, 'removed')).sort() };
  };

  const heldBy = (volumes) => ({
    STUB_VOLUMES_HELD: volumes.join(' '),
    STUB_HOLDERS: HOLDERS.join(' '),
  });

  const said = (out, text) => out.stdout.split('\n').some((l) => l.includes(text));

  // The names on the line that offers `command`, as the closing message gives them.
  const offered = (out, command) => {
    const line = out.stdout.split('\n').find((l) => l.trim().startsWith(`${command} `));
    return line
      ? line
          .trim()
          .slice(command.length + 1)
          .split(' ')
          .sort()
      : [];
  };

  const everything = [
    ...[...PROJECT_CONTAINERS, STRAY].map((name) => `container ${name}`),
    ...NETWORKS.map((name) => `network ${name}`),
    ...ALL.map((name) => `volume ${name}`),
    ...IMAGES.map((name) => `image ${name}`),
  ].sort();

  const assertNamedWithHolders = ({ out, calls }, volumes) => {
    for (const v of volumes) {
      const named = out.stdout
        .split('\n')
        .some((l) => l.includes(v) && HOLDERS.every((h) => l.includes(h)));
      assert.ok(named, `${v} is not named with its holders:\n${out.stdout}`);
      assert.ok(!said(out, `removed ${v}`), out.stdout);
      const asked = calls.some((c) => c.startsWith('ps') && c.includes(`volume=${v}`));
      assert.ok(asked, calls.join('\n'));
    }
  };

  const assertNotClean = ({ out }) => {
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, GONE);
    assert.match(out.stdout, /Still here/);
  };

  it('is plain ASCII, which Windows PowerShell 5.1 needs to read it without a byte order mark', () => {
    assert.doesNotMatch(readFileSync(join(dir, 'uninstall.ps1'), 'utf8'), /[^\x00-\x7F]/);
  });

  describe('when it can remove everything', () => {
    it('-Purge removes all of it, then says so and exits 0', () => {
      const { out, removed } = run(['-Purge', '-Yes']);
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.match(out.stdout, /Everything this install owned is gone\./);
      assert.doesNotMatch(out.stdout, /Still here/);
      assert.deepEqual(removed, everything);
    });

    it('without -Purge the work volumes are kept and listed, and are not counted as left', () => {
      const { out, calls, removed } = run(['-Yes']);
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.match(out.stdout, /Kept, because it holds your work/);
      for (const v of [...WORK, ...PER_TASK]) assert.ok(said(out, `  ${v}`), out.stdout);
      assert.match(out.stdout, /The stack is gone either way/);
      assert.doesNotMatch(out.stdout, /Still here/);
      assert.deepEqual(
        calls.filter((c) => c.startsWith('volume rm')),
        RUNTIME.map((v) => `volume rm ${v}`),
      );
      assert.ok(removed.every((r) => !WORK.concat(PER_TASK).some((v) => r === `volume ${v}`)));
    });

    it('a volume that does not exist is not an error', () => {
      const present = [`${ID}_postgres_data`, `${ID}_repos`];
      const { out } = run(['-Purge', '-Yes'], { STUB_VOLUMES: present.join(' ') });
      assert.equal(out.status, 0, out.stdout + out.stderr);
      for (const v of present) assert.ok(said(out, `removed ${v}`), out.stdout);
      for (const v of ALL.filter((name) => !present.includes(name))) {
        assert.ok(!out.stdout.includes(v), `${v} does not exist but is mentioned:\n${out.stdout}`);
      }
      assert.match(out.stdout, /Everything this install owned is gone\./);
    });
  });

  describe('when something is left, it says what and exits 1', () => {
    it('-Purge: volumes it cannot remove are named with their holders and offered for removal', () => {
      const held = [`${ID}_postgres_data`, `${ID}_repos`, `${ID}_cli_auth_t1`];
      const result = run(['-Purge', '-Yes'], heldBy(held));
      assertNotClean(result);
      assertNamedWithHolders(result, held);
      assert.ok(said(result.out, `removed ${ID}_redis_data`), result.out.stdout);
      assert.deepEqual(offered(result.out, 'docker volume rm'), held.slice().sort());
    });

    it('without -Purge: a runtime volume it cannot remove is too, and the work volumes are left alone', () => {
      const held = [`${ID}_postgres_data`];
      const result = run(['-Yes'], heldBy(held));
      assertNotClean(result);
      assertNamedWithHolders(result, held);
      assert.deepEqual(offered(result.out, 'docker volume rm'), held);
      assert.deepEqual(
        result.calls.filter((c) => c.startsWith('volume rm')),
        RUNTIME.map((v) => `volume rm ${v}`),
      );
    });

    for (const args of [['-Purge', '-Yes'], ['-Yes']]) {
      it(`${args[0] === '-Yes' ? 'without -Purge' : '-Purge'}: a network it cannot remove is named and offered for removal`, () => {
        const result = run(args, HELD_NETWORK);
        assertNotClean(result);
        assert.ok(said(result.out, `COULD NOT remove network ${NETWORKS[0]}`), result.out.stdout);
        assert.deepEqual(offered(result.out, 'docker network rm'), [NETWORKS[0]]);
        assert.doesNotMatch(result.out.stdout, /docker volume rm/);
      });
    }

    it('a network and a volume left together are both offered', () => {
      const held = [`${ID}_postgres_data`];
      const result = run(['-Purge', '-Yes'], { ...HELD_NETWORK, ...heldBy(held) });
      assertNotClean(result);
      assert.deepEqual(offered(result.out, 'docker network rm'), [NETWORKS[0]]);
      assert.deepEqual(offered(result.out, 'docker volume rm'), held);
    });

    it('a container outside the compose project that it cannot remove is offered', () => {
      const result = run(['-Yes'], { STUB_CONTAINERS_STUCK: STRAY });
      assertNotClean(result);
      assert.deepEqual(offered(result.out, 'docker rm -f'), [STRAY]);
      assert.doesNotMatch(result.out.stdout, /removed \d+ container/);
      for (const name of PROJECT_CONTAINERS)
        assert.ok(result.removed.includes(`container ${name}`));
    });

    it('compose down failing leaves the containers of the project offered', () => {
      const orphans = [`${ID}_api_1`, `${ID}_web_1`];
      const result = run(['-Purge', '-Yes'], {
        STUB_DOWN_FAILS: '1',
        STUB_CONTAINERS: orphans.join(' '),
        STUB_PROJECT_CONTAINERS: orphans.join(' '),
      });
      assertNotClean(result);
      assert.deepEqual(offered(result.out, 'docker rm -f'), orphans);
    });

    it('a compose project not named after the install is what its containers and runtime volumes are looked up by', () => {
      const held = `${OTHER_PROJECT}_postgres_data`;
      const orphans = [`${OTHER_PROJECT}_api_1`];
      const result = run(
        ['-Yes'],
        {
          ...heldBy([held]),
          STUB_PROJECT: OTHER_PROJECT,
          STUB_VOLUMES: [held, `${OTHER_PROJECT}_redis_data`].join(' '),
          STUB_DOWN_FAILS: '1',
          STUB_CONTAINERS: orphans.join(' '),
          STUB_PROJECT_CONTAINERS: orphans.join(' '),
        },
        otherProjectDir,
      );
      assertNotClean(result);
      assert.deepEqual(offered(result.out, 'docker volume rm'), [held]);
      assert.deepEqual(offered(result.out, 'docker rm -f'), orphans);
      assert.ok(result.removed.includes(`volume ${OTHER_PROJECT}_redis_data`));
    });

    it('-Purge: an image it cannot remove is offered', () => {
      const result = run(['-Purge', '-Yes'], { STUB_IMAGES_STUCK: IMAGES[1] });
      assertNotClean(result);
      assert.deepEqual(offered(result.out, 'docker rmi -f'), [IMAGES[1]]);
      assert.ok(result.removed.includes(`image ${IMAGES[0]}`));
    });
  });

  describe('without a Docker daemon', () => {
    it('one that is unreachable from the start: says so, removes nothing, exits 1', () => {
      const { out, calls, removed } = run(['-Purge', '-Yes'], { STUB_DAEMON_DOWN: '1' });
      assert.equal(out.status, 1, out.stdout + out.stderr);
      assert.match(out.stdout + out.stderr, /Docker daemon/);
      assert.doesNotMatch(out.stdout + out.stderr, GONE);
      assert.deepEqual(calls, ['info']);
      assert.deepEqual(removed, []);
    });

    it('one that stops answering before the final check: nothing is claimed gone or kept', () => {
      const dies = `volume rm ${RUNTIME.at(-1)}`;
      const { out } = run(['-Yes'], { STUB_DIES_AFTER: dies });
      assert.equal(out.status, 1, out.stdout + out.stderr);
      assert.doesNotMatch(out.stdout, GONE);
      assert.match(out.stdout, /stopped answering/);
      assert.match(out.stdout, /unknown: Docker stopped answering/);
      assert.doesNotMatch(out.stdout, /never cloned/);
    });
  });
});
