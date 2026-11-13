import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const image = 'mcr.microsoft.com/powershell:lts-7.4-alpine-3.20';
const hostPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const containerPwsh = !hostPwsh && spawnSync('docker', ['image', 'inspect', image]).status === 0;
const skipPwsh = process.env.HAIVE_INSTALLER_SKIP_PWSH === '1';
const skipBaseline = process.env.HAIVE_INSTALLER_SKIP_BASELINE === '1';
if (process.env.CI && !skipPwsh)
  test('CI requires a PowerShell harness', () => assert.ok(hostPwsh || containerPwsh));
const token = 'channel-test-secret';
const registry = '127.0.0.1:54321/vendor';
const pins = Object.fromEntries(
  ['api', 'worker', 'web', 'builder'].map((host) => [
    host,
    `${registry}/haive-customer-${host}@sha256:${'a'.repeat(64)}`,
  ]),
);
const manifest = { channel: 'customer', version: '9.9.9', images: pins };
const docker = `#!/bin/sh
printf 'config=%s' "$DOCKER_CONFIG" >> "$CALLS"
for arg do printf '\\t%s' "$arg" >> "$CALLS"; done
printf '\\n' >> "$CALLS"
if [ "$EXPECT_CHANNEL" = 1 ] && [ -n "$HAIVE_REGISTRY_TOKEN" ]; then echo token_in_environment >&2; exit 91; fi
# Enforce context-store lookup on commands that reach the daemon. Configs in
# this fixture use ASCII context names, including JSON's escaped spelling of x.
case "$*" in 'compose version'*) echo 2.30.0; exit 0 ;; esac
case "$1" in
 pull|create|run|compose)
  selected=$DOCKER_CONTEXT
  if [ -z "$selected" ] && [ -f "$DOCKER_CONFIG/config.json" ]; then
    selected=$(tr -d '\\r\\n' < "$DOCKER_CONFIG/config.json" | sed -n 's/.*"currentContext"[[:space:]]*:[[:space:]]*"\\([^" ]*\\)".*/\\1/p' | sed 's/\\\\u0078/x/g')
  fi
  if [ -n "$selected" ] && [ "$selected" != default ]; then
    if command -v sha256sum >/dev/null 2>&1; then hash=$(printf '%s' "$selected" | sha256sum)
    else hash=$(printf '%s' "$selected" | shasum -a 256); fi
    hash=\${hash%% *}
    [ -d "$DOCKER_CONFIG/contexts/meta/$hash" ] || { echo "missing selected context metadata: $selected" >&2; exit 92; }
  fi ;;
esac
case "$1" in
 run) printf '%s\\n%s\\n' "$DATABASE_URL" "$CONFIG_ENCRYPTION_KEY" > "$CASE_ROOT/updater-env" ;;
 login) cp "$DOCKER_CONFIG/config.json" "$CASE_ROOT/login-config.json"; if [ -d "$DOCKER_CONFIG/contexts" ]; then cp -R "$DOCKER_CONFIG/contexts" "$CASE_ROOT/seen-contexts"; fi; printf '%s\\n%s\\n' "$DOCKER_HOST" "$DOCKER_CONTEXT" > "$CASE_ROOT/daemon-env"; cat > "$CASE_ROOT/stdin"; [ "$FAIL_AT" != login ] || exit 1 ;;
 pull) [ "$FAIL_AT" != pull ] || exit 1 ;;
 create) [ "$FAIL_AT" != create ] || exit 1; echo unit-manifest; touch "$CASE_ROOT/container" ;;
 cp) [ "$FAIL_AT" != cp ] || exit 1; cp "$CASE_ROOT/manifest.json" "$3" ;;
 rm) [ "$FAIL_AT" != rm ] || exit 1; rm -f "$CASE_ROOT/container" ;;
 compose) case "$*" in *version*) echo 2.30.0 ;; esac ;;
 volume) [ "$2" != inspect ] || exit 1 ;;
esac
exit 0
`;
const curl = `#!/bin/sh
printf network >> "$CASE_ROOT/network-calls"
[ "$FAIL_AT" != bundle ] || exit 1
prev=; out=
for arg do [ "$prev" != -o ] || out=$arg; prev=$arg; done
case "$out" in *docker-compose*) printf 'services: {}\\n' > "$out" ;; esac
exit 0
`;
// Only these secret-transport edits, the recovery subcommand tested below and the
// explicit PowerShell install-id reorder may differ from the public baseline.
const publicSecretChanges = {
  sh: [
    [
      '    exec docker run --rm -it \\\n',
      '    DATABASE_URL="postgres://${POSTGRES_USER:-haive}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-haive}" \\\n    CONFIG_ENCRYPTION_KEY="${CONFIG_ENCRYPTION_KEY}" \\\n    exec docker run --rm -it \\\n',
    ],
    [
      '      -e DATABASE_URL="postgres://${POSTGRES_USER:-haive}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-haive}"',
      '      -e DATABASE_URL',
    ],
    ['      -e CONFIG_ENCRYPTION_KEY="${CONFIG_ENCRYPTION_KEY}"', '      -e CONFIG_ENCRYPTION_KEY'],
  ],
  ps1: [
    [
      "      '-e', \"DATABASE_URL=postgres://haive:$($e['POSTGRES_PASSWORD'])@postgres:5432/haive\",",
      "      '-e', 'DATABASE_URL',",
    ],
    [
      "      '-e', \"CONFIG_ENCRYPTION_KEY=$($e['CONFIG_ENCRYPTION_KEY'])\",",
      "      '-e', 'CONFIG_ENCRYPTION_KEY',",
    ],
    [
      '    & docker @dargs',
      "    $previousDatabaseUrl = $env:DATABASE_URL\n    $previousEncryptionKey = $env:CONFIG_ENCRYPTION_KEY\n    try {\n      $env:DATABASE_URL = \"postgres://haive:$($e['POSTGRES_PASSWORD'])@postgres:5432/haive\"\n      $env:CONFIG_ENCRYPTION_KEY = $e['CONFIG_ENCRYPTION_KEY']\n      & docker @dargs\n    } finally {\n      $env:DATABASE_URL = $previousDatabaseUrl\n      $env:CONFIG_ENCRYPTION_KEY = $previousEncryptionKey\n    }",
    ],
  ],
};
function approvedPublicSecrets(lang, text) {
  for (const [before, after] of publicSecretChanges[lang]) {
    assert.ok(text.includes(before), `baseline contains ${before}`);
    text = text.replace(before, after);
  }
  return text;
}
function fixture(
  lang,
  { publicInstall = false, data = manifest, fail = '', source, installDir, start = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'channel-installer-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const dir = installDir ?? join(root, 'install');
  const calls = join(root, 'calls');
  writeFileSync(
    join(root, 'manifest.json'),
    typeof data === 'string' ? data : JSON.stringify(data),
  );
  writeFileSync(join(bin, 'docker'), docker, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), curl, { mode: 0o755 });
  for (const command of ['mkdir', 'mv'])
    writeFileSync(
      join(bin, command),
      `#!/bin/sh
if [ "$FAIL_AT" = race ]; then
  for arg do
    case "$arg" in
      .docker|*/install/.docker)
        /bin/mkdir "$arg" 2>/dev/null && printf user-owned > "$arg/config.json" ;;
    esac
  done
fi
if [ "$FAIL_AT" = credential-move ] && [ "$1" != "" ]; then
  case "$1" in */.docker/config.json) exit 1 ;; esac
fi
exec /bin/${command} "$@"
`,
      { mode: 0o755 },
    );
  writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nprintf 0123456789abcdef\n', { mode: 0o755 });
  writeFileSync(join(bin, 'date'), '#!/bin/sh\necho 2000-01-01T00:00:00Z\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = join(root, `install.${lang}`);
  const selected =
    source ??
    (process.env.HAIVE_TEST_INSTALLER_DIR
      ? readFileSync(join(process.env.HAIVE_TEST_INSTALLER_DIR, `install.${lang}`), 'utf8')
      : undefined) ??
    (process.env.HAIVE_TEST_INSTALLER_REF
      ? spawnSync(
          'git',
          ['show', `${process.env.HAIVE_TEST_INSTALLER_REF}:install/install.${lang}`],
          { cwd: repo, encoding: 'utf8' },
        ).stdout
      : readFileSync(join(repo, 'install', `install.${lang}`), 'utf8'));
  // Supply deterministic randomness to both versions for the byte comparison.
  writeFileSync(
    script,
    selected.replace(
      '[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)',
      '$b[0] = 0',
    ),
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAIVE_GPU: 'cpu',
    HAIVE_REGISTRY_TOKEN: token,
    CASE_ROOT: root,
    CALLS: calls,
    FAIL_AT: fail,
    EXPECT_CHANNEL: publicInstall ? '0' : '1',
    TMPDIR: root,
    HOME: root,
    USERPROFILE: root,
    DOCKER_CONFIG: join(root, 'installer-empty-config'),
    DOCKER_HOST: '',
    DOCKER_CONTEXT: '',
  };
  const invoke = (file, args) => {
    const childEnv = { ...env, EXPECT_CHANNEL: file === script ? env.EXPECT_CHANNEL : '0' };
    if (lang === 'sh')
      return spawnSync('sh', [file, ...args], { cwd: root, env: childEnv, encoding: 'utf8' });
    // Windows-only host probes/downloads are replaced; all installer and generated helper code runs.
    const wrapper = join(root, 'invoke.ps1');
    writeFileSync(
      wrapper,
      `${file === script ? '' : `function docker { if ($args[0] -eq 'run') { [IO.File]::WriteAllText((Join-Path $env:CASE_ROOT 'helper-argv.json'), (ConvertTo-Json -InputObject @($args) -Compress -Depth 10)) }; & (Join-Path $env:CASE_ROOT 'bin/docker') @args }\n`}$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\nfunction Move-Item { param($LiteralPath,$Destination); if($env:FAIL_AT -eq 'credential-move' -and $LiteralPath -like '*/.docker/config.json'){ throw 'credential move failure' }; Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters; if($env:FAIL_AT -eq 'credential-stop' -and $LiteralPath -like '*/.docker/config.json'){ throw [System.Management.Automation.PipelineStoppedException]::new() }; if($env:FAIL_AT -eq 'unprotect-move'){ & chmod 755 (Split-Path $Destination); & chmod 644 $Destination } }\nfunction New-Item { param($ItemType,$Path,[switch]$Force); if($Path -like '*/snapshots' -and $env:FAIL_AT -in @('mkdir','pipeline-stop')) { if($env:FAIL_AT -eq 'pipeline-stop'){ throw [System.Management.Automation.PipelineStoppedException]::new() }; throw 'post-verification mkdir failure' }; Microsoft.PowerShell.Management\\New-Item @PSBoundParameters }\nfunction Get-CimInstance { [pscustomobject]@{TotalPhysicalMemory=16GB} }\nfunction Get-Date { '2000-01-01T00:00:00Z' }\nfunction Invoke-RestMethod { param($Uri); [IO.File]::AppendAllText((Join-Path $env:CASE_ROOT 'network-calls'), $Uri); [pscustomobject]@{tag_name='v9.9.9'} }\nfunction Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$Method,$TimeoutSec); [IO.File]::AppendAllText((Join-Path $env:CASE_ROOT 'network-calls'), $Uri); if($OutFile){ if($env:FAIL_AT -eq 'bundle'){ throw 'bundle failure' }; [IO.File]::WriteAllText($OutFile, "services: {}\\n") } }\n& '${file.replaceAll("'", "''")}' ${args.map((x) => (/^--?(version|dir|install-id|installId|no-start|noStart|channel|channel-registry|registry-user|channelRegistry|registryUser|check|force|yes|ForceDrain)$/i.test(x) ? x : `'${x.replaceAll("'", "''")}'`)).join(' ')}\nexit $LASTEXITCODE\n`,
    );
    if (hostPwsh)
      return spawnSync('pwsh', ['-NoProfile', '-File', wrapper], {
        cwd: root,
        env: childEnv,
        encoding: 'utf8',
      });
    const pass = Object.entries({
      ...childEnv,
      PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      USERPROFILE: childEnv.USERPROFILE,
    })
      .filter(([key]) =>
        [
          'PATH',
          'USERPROFILE',
          'HAIVE_GPU',
          'HAIVE_REGISTRY_TOKEN',
          'CASE_ROOT',
          'CALLS',
          'FAIL_AT',
          'EXPECT_CHANNEL',
          'TMPDIR',
          'HOME',
          'DOCKER_CONFIG',
          'DOCKER_HOST',
          'DOCKER_CONTEXT',
        ].includes(key),
      )
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        `t536-installer-${process.pid}-${Math.random().toString(16).slice(2)}`,
        '--pull',
        'never',
        '--network',
        'none',
        '--workdir',
        root,
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '-v',
        `${root}:${root}`,
        ...(installDir ? ['-v', `${resolve(installDir, '..')}:${resolve(installDir, '..')}`] : []),
        ...pass,
        image,
        'pwsh',
        '-NoProfile',
        '-File',
        wrapper,
      ],
      { encoding: 'utf8' },
    );
  };
  const flag = (s) =>
    lang === 'sh' ? `--${s}` : `-${s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`;
  const install = (extra = []) => {
    const args = [
      flag('version'),
      '9.9.9',
      flag('dir'),
      dir,
      flag('install-id'),
      'unit',
      ...(start ? [] : [flag('no-start')]),
      ...(publicInstall
        ? []
        : [
            flag('channel'),
            'customer',
            flag('channel-registry'),
            registry,
            flag('registry-user'),
            'installer',
          ]),
    ];
    for (let i = 0; i < extra.length; i++) {
      const existing = args.indexOf(extra[i]);
      if (existing >= 0 && extra[i + 1] !== undefined) args.splice(existing, 2);
    }
    return invoke(script, [...args, ...extra]);
  };
  return {
    root,
    dir,
    script,
    env,
    invoke,
    flag,
    install,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
for (const lang of ['sh', 'ps1']) {
  const options = {
    skip:
      lang === 'ps1' && (skipPwsh || (!process.env.CI && !hostPwsh && !containerPwsh))
        ? 'pwsh unavailable; pull the existing harness PowerShell image or run in CI'
        : false,
  };
  const check = (name, fn) => test(`${lang}: ${name}`, options, fn);
  if (lang === 'sh') {
    for (const publicInstall of [true, false]) {
      check(
        `recover-admin uses this install and forwards arguments (public=${publicInstall})`,
        () => {
          const f = fixture(lang, { publicInstall });
          try {
            assert.equal(f.install().status, 0);
            const args = [
              '--email',
              'admin@example.com',
              '--user-id',
              '00000000-0000-4000-8000-000000000001',
            ];
            const result = f.invoke(join(f.dir, 'haive'), ['recover-admin', ...args]);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const argv = f.calls().trim().split('\n').at(-1).split('\t');
            assert.deepEqual(argv.slice(-args.length), args);
            for (const value of [
              'unit-network',
              'HAIVE_INSTALL_ID=unit',
              'DATABASE_URL',
              'REDIS_URL=redis://redis:6379',
              'CONFIG_ENCRYPTION_KEY',
              '--entrypoint',
              'node',
              'ghcr.io/martinambrus/haive-updater:9.9.9',
              'packages/updater/dist/recover-admin-cli.js',
            ])
              assert.ok(argv.includes(value), value);
            assert.ok(!argv.includes('-v'), 'recovery needs no host mounts');
            assert.ok(
              !argv.some(
                (arg) =>
                  arg.startsWith('DATABASE_URL=') || arg.startsWith('CONFIG_ENCRYPTION_KEY='),
              ),
              'secrets travel in the environment rather than argv',
            );
            const env = readFileSync(join(f.root, 'updater-env'), 'utf8');
            assert.ok(env.startsWith('postgres://haive:'));
            assert.ok(env.includes('@postgres:5432/haive\n'));
            assert.ok(env.trim().split('\n')[1]);
          } finally {
            f.clean();
          }
        },
      );
    }
  }
  check('leftover fixture config and home cannot affect another run', () => {
    const leftover = fixture(lang);
    const current = fixture(lang);
    try {
      for (const key of ['DOCKER_CONFIG', 'HOME', 'USERPROFILE'])
        assert.notEqual(current.env[key], leftover.env[key], `${key} belongs to each fixture`);
      // A killed run may leave a selected context whose metadata no longer exists.
      mkdirSync(leftover.env.DOCKER_CONFIG);
      const stale = JSON.stringify({ currentContext: 'missing', auths: {} });
      writeFileSync(join(leftover.env.DOCKER_CONFIG, 'config.json'), stale);
      const r = current.install();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(readFileSync(join(leftover.env.DOCKER_CONFIG, 'config.json'), 'utf8'), stale);
    } finally {
      leftover.clean();
      current.clean();
    }
  });
  for (const selection of [
    'config',
    'host env',
    'context env',
    'context env default',
    'context env empty',
    'default',
    'symlink',
    'escaped',
  ])
    check(`daemon context preserved without user credentials: ${selection}`, () => {
      const f = fixture(lang, { start: true });
      const userConfig = join(f.root, 'user-docker');
      f.env.DOCKER_CONFIG = userConfig;
      const currentContext = selection.includes('default')
        ? 'default'
        : selection.endsWith('empty')
          ? ''
          : 'x';
      let original = JSON.stringify({
        auths: { private: { auth: 'user-secret' } },
        credsStore: 'currentContext',
        credHelpers: { private: 'helper' },
        currentContext,
      });
      if (selection === 'escaped')
        original = original.replace('"currentContext":"x"', '"currentContext":"\\u0078"');
      const hash = (name) => createHash('sha256').update(name).digest('hex');
      const store = join(f.root, 'real-contexts');
      try {
        mkdirSync(userConfig);
        mkdirSync(store);
        for (const name of ['x', 'override'])
          for (const kind of ['meta', 'tls']) {
            const entry = join(store, kind, hash(name));
            mkdirSync(entry, { recursive: true });
            writeFileSync(
              join(entry, kind === 'meta' ? 'meta.json' : 'key.pem'),
              kind === 'meta' ? JSON.stringify({ Name: name }) : `secret-${name}`,
            );
            chmodSync(entry, 0o755);
            chmodSync(join(entry, kind === 'meta' ? 'meta.json' : 'key.pem'), 0o644);
          }
        if (selection === 'symlink') symlinkSync(store, join(userConfig, 'contexts'));
        else mkdirSync(join(userConfig, 'contexts'));
        if (selection !== 'symlink')
          for (const kind of ['meta', 'tls']) {
            mkdirSync(join(userConfig, 'contexts', kind));
            for (const name of ['x', 'override'])
              symlinkSync(
                join(store, kind, hash(name)),
                join(userConfig, 'contexts', kind, hash(name)),
              );
          }
        writeFileSync(join(userConfig, 'config.json'), original);
        if (selection === 'host env') f.env.DOCKER_HOST = 'unix:///selected.sock';
        if (selection.startsWith('context env')) f.env.DOCKER_CONTEXT = 'override';
        const r = f.install();
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const staged = JSON.parse(readFileSync(join(f.root, 'login-config.json'), 'utf8'));
        assert.equal(staged.currentContext, currentContext);
        assert.deepEqual(Object.keys(staged).sort(), ['auths', 'currentContext']);
        assert.deepEqual(Object.keys(staged.auths), ['127.0.0.1:54321']);
        const wanted = [...new Set([currentContext, f.env.DOCKER_CONTEXT])].filter(
          (name) => name && name !== 'default',
        );
        for (const kind of ['meta', 'tls']) {
          const seen = join(f.root, 'seen-contexts', kind);
          assert.deepEqual(
            existsSync(seen) ? readdirSync(seen).sort() : [],
            wanted.map(hash).sort(),
          );
          const final = join(f.dir, '.docker/contexts', kind);
          assert.deepEqual(
            existsSync(final) ? readdirSync(final).sort() : [],
            wanted.map(hash).sort(),
          );
          for (const name of wanted)
            assert.equal(lstatSync(join(final, hash(name))).isSymbolicLink(), false);
          for (const name of ['x', 'override']) {
            assert.equal(statSync(join(store, kind, hash(name))).mode & 0o777, 0o755);
            assert.equal(
              statSync(join(store, kind, hash(name), kind === 'meta' ? 'meta.json' : 'key.pem'))
                .mode & 0o777,
              0o644,
            );
          }
        }
        assert.equal(
          readFileSync(join(f.root, 'daemon-env'), 'utf8'),
          `${f.env.DOCKER_HOST}\n${f.env.DOCKER_CONTEXT}\n`,
        );
        assert.equal(readFileSync(join(userConfig, 'config.json'), 'utf8'), original);
        const final = JSON.parse(readFileSync(join(f.dir, '.docker/config.json'), 'utf8'));
        assert.equal(
          final.currentContext,
          currentContext && currentContext !== 'default' ? currentContext : undefined,
        );
        for (const verb of ['pull', 'up']) {
          assert.ok(
            f
              .calls()
              .split('\n')
              .some(
                (line) =>
                  line.startsWith(`config=${f.dir}/.docker\tcompose\t`) &&
                  line.split('\t').includes(verb),
              ),
            `install-time ${verb} uses final config`,
          );
          const helper = join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1');
          const r = f.invoke(helper, [verb]);
          assert.equal(r.status, 0, r.stdout + r.stderr);
          const call = f.calls().trim().split('\n').at(-1);
          assert.ok(call.startsWith(`config=${f.dir}/.docker\tcompose\t`));
          assert.ok(call.split('\t').includes(verb));
        }
      } finally {
        f.clean();
      }
    });
  for (const selected of ['config', 'environment'])
    check(`missing selected context fails closed: ${selected}`, () => {
      const f = fixture(lang);
      try {
        const config = join(f.root, 'user-docker');
        mkdirSync(config);
        writeFileSync(
          join(config, 'config.json'),
          JSON.stringify({ currentContext: selected === 'config' ? 'missing' : 'default' }),
        );
        f.env.DOCKER_CONFIG = config;
        if (selected === 'environment') f.env.DOCKER_CONTEXT = 'missing';
        const r = f.install();
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /selected Docker context.*metadata/i);
        assert.ok(!f.calls().includes('\tlogin\t'));
        assert.ok(!existsSync(f.dir));
      } finally {
        f.clean();
      }
    });
  if (lang === 'sh')
    for (const hashTools of ['fallback', 'missing'])
      check(`context hash tools: ${hashTools}`, () => {
        const source = readFileSync(join(repo, 'install/install.sh'), 'utf8')
          .replace('command -v sha256sum', 'false')
          .replace('command -v shasum', hashTools === 'missing' ? 'false' : 'command -v shasum');
        const f = fixture(lang, { source });
        try {
          const config = join(f.root, 'user-docker');
          const hash = createHash('sha256').update('x').digest('hex');
          mkdirSync(join(config, 'contexts/meta', hash), { recursive: true });
          writeFileSync(join(config, 'contexts/meta', hash, 'meta.json'), '{"Name":"x"}');
          writeFileSync(join(config, 'config.json'), '{"currentContext":"x"}');
          f.env.DOCKER_CONFIG = config;
          const r = f.install();
          if (hashTools === 'fallback') {
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.ok(existsSync(join(f.dir, '.docker/contexts/meta', hash, 'meta.json')));
          } else {
            assert.notEqual(r.status, 0);
            assert.match(r.stdout + r.stderr, /require sha256sum or shasum/);
            assert.ok(!f.calls().includes('\tlogin\t'));
            assert.ok(!existsSync(f.dir));
          }
        } finally {
          f.clean();
        }
      });
  for (const hash of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])
    check(`invalid computed context hash fails closed: ${hash}`, () => {
      const original = readFileSync(join(repo, `install/install.${lang}`), 'utf8');
      const marker =
        lang === 'sh' ? '    CHANNEL_HASH=${CHANNEL_HASH%% *}' : '      finally { $sha.Dispose() }';
      assert.ok(original.includes(marker));
      const source = original.replace(
        marker,
        `${marker}\n${lang === 'sh' ? `    CHANNEL_HASH='${hash}'` : `      $hash = '${hash}'`}`,
      );
      const f = fixture(lang, { source });
      try {
        const config = join(f.root, 'user-docker');
        // Supply metadata at the corrupt hash so metadata existence cannot mask a missing validator.
        mkdirSync(join(config, 'contexts/meta', hash), { recursive: true });
        writeFileSync(join(config, 'contexts/meta', hash, 'meta.json'), '{"Name":"x"}');
        writeFileSync(join(config, 'config.json'), '{"currentContext":"x"}');
        f.env.DOCKER_CONFIG = config;
        const r = f.install([f.flag('check')]);
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /invalid.*Docker context hash/i);
        assert.ok(!f.calls().includes('\tlogin\t'));
        assert.ok(!existsSync(f.dir));
      } finally {
        f.clean();
      }
    });
  check('generated helper upgrade without extra arguments has clean argv', () => {
    const f = fixture(lang);
    try {
      assert.equal(f.install().status, 0);
      const r = f.invoke(
        join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1'),
        lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'],
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
      // Preserve trailing tabs: trim() would hide a null/empty final argument.
      const argv = f.calls().split('\n').filter(Boolean).at(-1).split('\t').slice(1);
      assert.ok(
        argv.every((arg) => arg.length > 0),
        JSON.stringify(argv),
      );
      if (lang === 'ps1') {
        const splatted = JSON.parse(readFileSync(join(f.root, 'helper-argv.json'), 'utf8'));
        assert.ok(
          splatted.every((arg) => typeof arg === 'string' && arg.length > 0),
          JSON.stringify(splatted),
        );
      }
    } finally {
      f.clean();
    }
  });
  for (const version of [undefined, 'latest', 'next'])
    check(`channel requires explicit version before network: ${version ?? 'omitted'}`, () => {
      const f = fixture(lang);
      try {
        const r = f.invoke(f.script, [
          ...(version === undefined ? [] : [f.flag('version'), version]),
          f.flag('dir'),
          f.dir,
          f.flag('install-id'),
          'unit',
          f.flag('channel'),
          'customer',
          f.flag('registry-user'),
          'installer',
          f.flag('no-start'),
        ]);
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /channel.*explicit.*version/i);
        assert.ok(!existsSync(join(f.root, 'network-calls')), 'no network calls');
        assert.equal(f.calls(), '', 'no Docker calls');
        assert.ok(!existsSync(f.dir));
      } finally {
        f.clean();
      }
    });
  check('shared GNU flag spellings install the same channel', () => {
    const f = fixture(lang);
    try {
      const r = f.invoke(f.script, [
        '--version',
        '9.9.9',
        '--dir',
        f.dir,
        '--install-id',
        'unit',
        '--channel',
        'customer',
        '--channel-registry',
        registry,
        '--registry-user',
        'installer',
        '--no-start',
      ]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(readFileSync(join(f.dir, '.env'), 'utf8'), /^HAIVE_CHANNEL=customer$/m);
    } finally {
      f.clean();
    }
  });
  for (const stale of ['directory', 'symlink', 'dangling symlink'])
    check(`stale .docker ${stale} refuses before writes and force retry succeeds`, () => {
      const f = fixture(lang);
      try {
        mkdirSync(f.dir);
        const config = join(f.dir, '.docker');
        if (stale === 'directory') mkdirSync(config);
        else {
          const target = join(f.root, 'old-config');
          if (stale === 'symlink') mkdirSync(target);
          symlinkSync(target, config);
        }
        const failed = f.install([f.flag('force')]);
        assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
        assert.match(failed.stdout + failed.stderr, /\.docker already exists/);
        assert.deepEqual(readdirSync(f.dir), ['.docker'], 'no install files written');
        assert.deepEqual(
          readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
          [],
          'no credential scratch remains',
        );
        rmSync(config, { recursive: true, force: true });
        const retry = f.install([f.flag('force')]);
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
        assert.ok(existsSync(join(f.dir, '.env')));
        assert.ok(existsSync(join(f.dir, 'docker-compose.yml')));
        assert.ok(existsSync(join(f.dir, '.docker/config.json')));
      } finally {
        f.clean();
      }
    });
  for (const fail of ['race', 'credential-move'])
    check(`exclusive credential placement refuses ${fail} and allows retry`, () => {
      const f = fixture(lang, { fail });
      try {
        const r = f.install();
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.ok(
          !existsSync(join(f.dir, '.env')),
          'remove only this run’s env so retry accepts it',
        );
        if (fail === 'race') {
          assert.match(r.stdout + r.stderr, /\.docker already exists/);
          assert.deepEqual(readdirSync(join(f.dir, '.docker')), ['config.json']);
          assert.equal(readFileSync(join(f.dir, '.docker/config.json'), 'utf8'), 'user-owned');
          rmSync(join(f.dir, '.docker'), { recursive: true });
        } else assert.ok(!existsSync(join(f.dir, '.docker')), 'no final credential after failure');
        assert.deepEqual(
          readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
          [],
        );
        f.env.FAIL_AT = '';
        const retry = f.install([f.flag('force')]);
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      } finally {
        f.clean();
      }
    });
  check('bundle failure leaves no final credential and force retry succeeds', () => {
    const f = fixture(lang, { fail: 'bundle' });
    try {
      const failed = f.install();
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      assert.ok(!existsSync(join(f.dir, '.docker')), 'no final credential after bundle failure');
      assert.ok(!existsSync(join(f.dir, '.env')));
      f.env.FAIL_AT = '';
      const retry = f.install([f.flag('force')]);
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.ok(existsSync(join(f.dir, '.docker/config.json')));
    } finally {
      f.clean();
    }
  });
  if (lang === 'ps1') {
    check('failed check reports one error and removes scratch', () => {
      const f = fixture(lang, { fail: 'login' });
      try {
        const r = f.install([f.flag('check')]);
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.ok(!existsSync(f.dir), 'check writes no install');
        assert.match(f.calls(), /\tlogin\t/);
        assert.deepEqual(
          readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
          [],
          'no credential scratch remains',
        );
        assert.equal((r.stdout + r.stderr).match(/error:/g)?.length, 1);
        assert.equal(r.stderr, '', 'no second PowerShell cleanup error');
      } finally {
        f.clean();
      }
    });
    check('pipeline stop after credential claim removes credentials and env', () => {
      const f = fixture(lang, { fail: 'credential-stop' });
      try {
        f.install();
        assert.ok(
          !existsSync(join(f.dir, '.docker')),
          'remove claimed credentials after pipeline stop',
        );
        assert.ok(!existsSync(join(f.dir, '.env')), 'remove this run’s env after pipeline stop');
        assert.deepEqual(
          readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
          [],
        );
        f.env.FAIL_AT = '';
        const retry = f.install([f.flag('force')]);
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      } finally {
        f.clean();
      }
    });
    for (const fail of ['mkdir', 'pipeline-stop', 'bundle'])
      check(`scratch removed after post-verification ${fail}`, () => {
        const f = fixture(lang, { fail });
        try {
          const r = f.install();
          // PowerShell pipeline cancellation can return status 0 to its caller.
          if (fail !== 'pipeline-stop') assert.notEqual(r.status, 0, r.stdout + r.stderr);
          assert.ok(!existsSync(join(f.dir, '.env')), 'installation stopped');
          assert.match(f.calls(), /\tcp\t/, 'verification finished');
          assert.deepEqual(
            readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
            [],
          );
        } finally {
          f.clean();
        }
      });
  }
  for (const pathForm of ['relative dot', 'interior dot', 'trailing slash', 'space'])
    check(`normalised config path: ${pathForm}`, () => {
      const f = fixture(lang);
      const target = join(f.root, pathForm === 'space' ? 'with space' : 'x');
      const dir =
        pathForm === 'relative dot'
          ? './x'
          : pathForm === 'interior dot'
            ? `${f.root}/./x`
            : pathForm === 'trailing slash'
              ? `${target}/`
              : target;
      try {
        const r = f.install([f.flag('dir'), dir]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const e = readFileSync(join(target, '.env'), 'utf8');
        assert.equal(
          e.split('\n').find((x) => x.startsWith('DOCKER_CONFIG=')),
          `DOCKER_CONFIG=${join(target, '.docker')}`,
        );
        assert.equal(
          e.split('\n').find((x) => x.startsWith('HAIVE_INSTALL_DIR_HOST=')),
          `HAIVE_INSTALL_DIR_HOST=${target}`,
        );
      } finally {
        f.clean();
      }
    });
  if (lang === 'ps1')
    check('credential protection reapplied after cross-volume style move', () => {
      const f = fixture(lang, { fail: 'unprotect-move' });
      try {
        const r = f.install();
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(statSync(join(f.dir, '.docker')).mode & 0o777, 0o700);
        assert.equal(statSync(join(f.dir, '.docker/config.json')).mode & 0o777, 0o600);
      } finally {
        f.clean();
      }
    });
  if (lang === 'ps1')
    check('public positional Version remains accepted', () => {
      const f = fixture(lang, { publicInstall: true });
      try {
        const r = f.invoke(f.script, ['0.1.4', '-Dir', f.dir, '-InstallId', 'unit', '-NoStart']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(readFileSync(join(f.dir, '.env'), 'utf8'), /^HAIVE_VERSION=0\.1\.4$/m);
      } finally {
        f.clean();
      }
    });
  if (lang === 'ps1') {
    for (const withId of [false, true])
      check(`public positional Version and Dir${withId ? ' and InstallId' : ''}`, () => {
        const f = fixture(lang, { publicInstall: true });
        try {
          const r = f.invoke(f.script, ['0.1.4', f.dir, ...(withId ? ['myid'] : []), '-NoStart']);
          assert.equal(r.status, 0, r.stdout + r.stderr);
          const e = readFileSync(join(f.dir, '.env'), 'utf8');
          assert.match(e, /^HAIVE_VERSION=0\.1\.4$/m);
          if (withId) assert.match(e, /^HAIVE_INSTALL_ID=myid$/m);
        } finally {
          f.clean();
        }
      });
    for (const named of ['dir', 'install-id'])
      for (const spelling of ['native', 'GNU'])
        check(`bare Version after named ${spelling} ${named} value`, () => {
          const f = fixture(lang, { publicInstall: true });
          const flag = spelling === 'GNU' ? `--${named}` : f.flag(named);
          const args =
            named === 'dir'
              ? [flag, f.dir, '0.1.4', '-InstallId', 'unit', '-NoStart']
              : [flag, 'unit', '0.1.4', '-Dir', f.dir, '-NoStart'];
          try {
            const r = f.invoke(f.script, args);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            const e = readFileSync(join(f.dir, '.env'), 'utf8');
            assert.match(e, /^HAIVE_VERSION=0\.1\.4$/m);
            assert.match(e, /^HAIVE_INSTALL_ID=unit$/m);
          } finally {
            f.clean();
          }
        });
    check('positional Channel follows Version Dir and InstallId', () => {
      const f = fixture(lang);
      try {
        const r = f.invoke(f.script, [
          '9.9.9',
          f.dir,
          'myid',
          'customer',
          '--channel-registry',
          registry,
          '--registry-user',
          'installer',
          '--no-start',
        ]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const e = readFileSync(join(f.dir, '.env'), 'utf8');
        assert.match(e, /^HAIVE_CHANNEL=customer$/m);
        assert.match(e, /^HAIVE_INSTALL_ID=myid$/m);
      } finally {
        f.clean();
      }
    });
    for (const versionFlag of ['-Version', '--version'])
      check(`positional arguments skip the ${versionFlag} named slot`, () => {
        const f = fixture(lang, { publicInstall: true });
        try {
          const r = f.invoke(f.script, [versionFlag, '0.1.4', f.dir, 'myid', '-NoStart']);
          assert.equal(r.status, 0, r.stdout + r.stderr);
          const e = readFileSync(join(f.dir, '.env'), 'utf8');
          assert.match(e, /^HAIVE_VERSION=0\.1\.4$/m);
          assert.match(e, /^HAIVE_INSTALL_ID=myid$/m);
        } finally {
          f.clean();
        }
      });
    check('positional token past Channel is an unknown option', () => {
      const f = fixture(lang, { publicInstall: true });
      try {
        const r = f.invoke(f.script, ['0.1.4', f.dir, 'myid', 'public', 'extra', '-NoStart']);
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /unknown option: extra/);
        assert.ok(!existsSync(f.dir));
      } finally {
        f.clean();
      }
    });
  }
  check('compose bundle mode matches public install', () => {
    const channel = fixture(lang);
    const pub = fixture(lang, { publicInstall: true });
    try {
      const a = channel.install();
      const b = pub.install();
      assert.equal(a.status, 0, a.stdout + a.stderr);
      assert.equal(b.status, 0, b.stdout + b.stderr);
      for (const name of ['docker-compose.yml', 'docker-compose.run.yml'])
        assert.equal(
          statSync(join(channel.dir, name)).mode & 0o777,
          statSync(join(pub.dir, name)).mode & 0o777,
          name,
        );
    } finally {
      channel.clean();
      pub.clean();
    }
  });
  check('manifest status is printed only after verification', () => {
    const fail = fixture(lang, { fail: 'cp' });
    const ok = fixture(lang);
    try {
      const a = fail.install();
      assert.notEqual(a.status, 0);
      assert.doesNotMatch(a.stdout, /manifest\s+(found|verified)/i);
      const b = ok.install();
      assert.equal(b.status, 0, b.stdout + b.stderr);
      assert.match(b.stdout, /manifest\s+verified/i);
      assert.doesNotMatch(b.stdout, /manifest\s+found/i);
    } finally {
      fail.clean();
      ok.clean();
    }
  });
  check('public helper puts every docker env option before the image', () => {
    const f = fixture(lang, { publicInstall: true });
    try {
      assert.equal(f.install().status, 0);
      const helper = join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1');
      const r = f.invoke(
        helper,
        lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'],
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const argv = f.calls().trim().split('\n').at(-1).split('\t').slice(1);
      const imageAt = argv.indexOf('ghcr.io/martinambrus/haive-updater:10.0.0');
      assert.ok(imageAt > 0);
      assert.ok(argv.includes('HAIVE_INSTALL_ID=unit'));
      argv.forEach((arg, i) => {
        if (arg === '-e') assert.ok(i < imageAt, `env at ${i} after image`);
      });
      assert.ok(argv.indexOf('--manifest') > imageAt);
    } finally {
      f.clean();
    }
  });
  for (const publicInstall of [true, false])
    check(
      `upgrade secret values stay in child env: ${publicInstall ? 'public' : 'channel'}`,
      () => {
        const f = fixture(lang, { publicInstall });
        try {
          assert.equal(f.install().status, 0);
          const e = Object.fromEntries(
            readFileSync(join(f.dir, '.env'), 'utf8')
              .split('\n')
              .filter((x) => x.includes('='))
              .map((x) => x.split('=')),
          );
          const helper = join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1');
          const r = f.invoke(
            helper,
            lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'],
          );
          assert.equal(r.status, 0, r.stdout + r.stderr);
          const call = f.calls().trim().split('\n').at(-1);
          assert.ok(!call.includes(e.POSTGRES_PASSWORD), 'no database password in argv');
          assert.ok(!call.includes(e.CONFIG_ENCRYPTION_KEY), 'no encryption key in argv');
          const argv = call.split('\t');
          assert.ok(argv.includes('DATABASE_URL'));
          assert.ok(argv.includes('CONFIG_ENCRYPTION_KEY'));
          const child = readFileSync(join(f.root, 'updater-env'), 'utf8').trimEnd().split('\n');
          assert.deepEqual(child, [
            `postgres://haive:${e.POSTGRES_PASSWORD}@postgres:5432/haive`,
            e.CONFIG_ENCRYPTION_KEY,
          ]);
        } finally {
          f.clean();
        }
      },
    );
  check('channel helper usage advertises channel changes', () => {
    const f = fixture(lang);
    try {
      assert.equal(f.install().status, 0);
      const r = f.invoke(join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1'), []);
      assert.match(r.stdout + r.stderr, /--change-channel <channel>/);
      const installer = readFileSync(join(repo, `install/install.${lang}`), 'utf8');
      assert.match(installer, /non-public channel.*explicit.*(?:--version|-Version)/i);
    } finally {
      f.clean();
    }
  });
  if (lang === 'sh')
    check('rewritten Docker config is private with a permissive ambient umask', () => {
      const source = readFileSync(join(repo, 'install/install.sh'), 'utf8').replace(
        '  # mkdir is the portable exclusive claim',
        '  umask 022\n  # mkdir is the portable exclusive claim',
      );
      const f = fixture(lang, { source });
      try {
        assert.equal(f.install().status, 0);
        assert.equal(statSync(join(f.dir, '.docker/config.json')).mode & 0o777, 0o600);
      } finally {
        f.clean();
      }
    });
  check('channel flags, private config and pinned env', () => {
    const f = fixture(lang);
    try {
      const r = f.install();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const e = readFileSync(join(f.dir, '.env'), 'utf8');
      for (const [key, value] of Object.entries({
        HAIVE_CHANNEL: 'customer',
        HAIVE_CHANNEL_REGISTRY: registry,
        DOCKER_CONFIG: join(f.dir, '.docker'),
        HAIVE_API_IMAGE: pins.api,
        HAIVE_WORKER_IMAGE: pins.worker,
        HAIVE_WEB_IMAGE: pins.web,
      }))
        assert.ok(e.includes(`${key}=${value}\n`), key);
      assert.equal(statSync(join(f.dir, '.docker')).mode & 0o777, 0o700);
      assert.equal(statSync(join(f.dir, '.docker/config.json')).mode & 0o777, 0o600);
      assert.ok(!f.calls().includes(token));
      assert.equal(readFileSync(join(f.root, 'stdin'), 'utf8').trim(), token);
      assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
      assert.ok(!existsSync(join(f.root, 'container')));
      assert.match(f.calls(), /\trm\t-f\thi-manifest-/);
    } finally {
      f.clean();
    }
  });
  for (const [field, values] of [
    ['channel', ['BAD', '-bad', 'bad-', 'good\nbad', 'good\n', 'a'.repeat(33)]],
    ['channel-registry', ['https://bad', 'bad/', 'Bad', 'bad,,x', 'good\nbad', 'good\n']],
  ])
    for (const value of values)
      check(`reject invalid ${field} ${value}`, () => {
        const f = fixture(lang);
        try {
          const r = f.install([f.flag(field), value]);
          assert.notEqual(r.status, 0);
          assert.match(
            r.stdout + r.stderr,
            new RegExp(field === 'channel' ? '[Cc]hannel' : '[Rr]egistry'),
          );
          assert.ok(!existsSync(join(f.dir, '.env')));
          assert.ok(!f.calls().includes('\tlogin\t'));
        } finally {
          f.clean();
        }
      });
  check('valid JSON extras retain escape, scalar and nesting support', () => {
    const data = JSON.stringify({
      ...manifest,
      extra: { text: '\"\\/\n\u0001', values: [null, true, false, -1.25e12, {}, []] },
    })
      .replace('"extra":', '"longNumber":1' + '0'.repeat(128) + ',"extra":')
      .replace('"extra":', '"boundary":' + '['.repeat(63) + '0' + ']'.repeat(63) + ',"extra":');
    const f = fixture(lang, { data });
    try {
      const r = f.install();
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      f.clean();
    }
  });
  for (const [name, data, fail] of [
    ...[
      ['split string', '"ab\ncd"'],
      ['split escape', '"ab\\\nn"'],
      ['split unicode escape', '"ab\\u00\n00"'],
      ['split number', '1\n2'],
      ['split keyword', 'tr\nue'],
    ].map(([name, value]) => [
      name,
      '{"extra":' + value + ',' + JSON.stringify(manifest).slice(1),
      '',
    ]),
    ...['01', '-', '-01', '1.', '1e', '1e+', '1e-', 'truex', 'nullx'].map((value) => [
      `invalid JSON scalar ${value}`,
      '{"extra":' + value + ',' + JSON.stringify(manifest).slice(1),
      '',
    ]),
    ['wrong channel', { ...manifest, channel: 'other' }, ''],
    ['wrong version', { ...manifest, version: '1.0.0' }, ''],
    [
      'foreign pin',
      { ...manifest, images: { ...pins, api: pins.api.replace(registry, 'evil.test') } },
      '',
    ],
    [
      'foreign builder',
      { ...manifest, images: { ...pins, builder: pins.builder.replace(registry, 'evil.test') } },
      '',
    ],
    [
      'registry prefix lookalike',
      { ...manifest, images: { ...pins, api: pins.api.replace('/vendor/', '/vendor2/') } },
      '',
    ],
    [
      'host suffix lookalike',
      { ...manifest, images: { ...pins, api: pins.api.replace('-api@', '-apix@') } },
      '',
    ],
    ['63 hex digits', { ...manifest, images: { ...pins, api: pins.api.slice(0, -1) } }, ''],
    ['65 hex digits', { ...manifest, images: { ...pins, api: pins.api + 'a' } }, ''],
    ['non-hex digest', { ...manifest, images: { ...pins, api: pins.api.slice(0, -1) + 'z' } }, ''],
    [
      'duplicate key',
      JSON.stringify(manifest).replace('"channel":', '"channel":"other","channel":'),
      '',
    ],
    ['escaped-quote key', '{"escaped\\\"key":0,' + JSON.stringify(manifest).slice(1), ''],
    ['non-object array root', JSON.stringify([manifest]), ''],
    ['non-object string root', JSON.stringify(JSON.stringify(manifest)), ''],
    ['non-object null root', 'null', ''],
    ['trailing garbage', JSON.stringify(manifest) + 'garbage', ''],
    ['second JSON object', JSON.stringify(manifest) + '{}', ''],
    ['JSON comment', '{/* comment */' + JSON.stringify(manifest).slice(1), ''],
    ['trailing object comma', JSON.stringify(manifest).slice(0, -1) + ',}', ''],
    ['trailing array comma', '{"extra":[0,],' + JSON.stringify(manifest).slice(1), ''],
    ['escaped unicode key', '{"extra\\u0061":0,' + JSON.stringify(manifest).slice(1), ''],
    ['slash key', '{"extra/key":0,' + JSON.stringify(manifest).slice(1), ''],
    ['DEL in string', '{"extra":"\u007f",' + JSON.stringify(manifest).slice(1), ''],
    ['UTF-8 BOM prefix', '\ufeff' + JSON.stringify(manifest), ''],
    [
      'escaped channel value',
      JSON.stringify(manifest).replace('customer', String.raw`\u0063ustomer`),
      '',
    ],
    [
      'escaped version value',
      JSON.stringify(manifest).replace('9.9.9', String.raw`\u0039.9.9`),
      '',
    ],
    ...Object.keys(pins).map((host) => [
      `escaped ${host} pin value`,
      JSON.stringify(manifest).replace(
        JSON.stringify(pins[host]),
        JSON.stringify(pins[host]).replace('127', String.raw`\u003127`),
      ),
      '',
    ]),
    ['unescaped control character', '{"extra":"\u0001",' + JSON.stringify(manifest).slice(1), ''],
    [
      'deep nesting',
      '{"extra":' + '['.repeat(65) + '0' + ']'.repeat(65) + ',' + JSON.stringify(manifest).slice(1),
      '',
    ],
    ['array channel', { ...manifest, channel: ['customer'] }, ''],
    ['array version', { ...manifest, version: ['9.9.9'] }, ''],
    ['oversized manifest', JSON.stringify(manifest) + ' '.repeat(1048576), ''],
    ['malformed JSON', '{"channel":', ''],
    ['missing pin', { ...manifest, images: { ...pins, web: null } }, ''],
    ['pin ending in newline', { ...manifest, images: { ...pins, api: pins.api + '\n' } }, ''],
    [
      'uppercase digest',
      {
        ...manifest,
        images: { ...pins, api: pins.api.replaceAll('a'.repeat(64), 'A'.repeat(64)) },
      },
      '',
    ],
    ['unpullable release', manifest, 'pull'],
    ['copy failure', manifest, 'cp'],
    ['login failure', manifest, 'login'],
    ['container removal failure', manifest, 'rm'],
  ])
    check(`refuse ${name} before writing`, () => {
      const f = fixture(lang, { data, fail });
      try {
        const r = f.install();
        assert.notEqual(r.status, 0);
        assert.ok(!existsSync(join(f.dir, '.env')));
        assert.ok(!existsSync(f.dir), 'failed verification leaves no install');
        if (f.calls().includes('\tcp\t')) assert.match(f.calls(), /\trm\t-f\thi-manifest-/);
        if (fail !== 'rm') assert.ok(!existsSync(join(f.root, 'container')));
        assert.ok(f.calls().includes('\tlogin\t'), 'reaches authenticated verification');
        assert.deepEqual(
          readdirSync(f.root).filter((x) => x.startsWith('haive-install')),
          [],
          'no credential scratch after failure',
        );
      } finally {
        f.clean();
      }
    });
  check('check authenticates, verifies, and removes scratch config', () => {
    const f = fixture(lang);
    try {
      const r = f.install([f.flag('check')]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(!existsSync(f.dir));
      assert.match(f.calls(), /\tlogin\t/);
      assert.match(f.calls(), /\tcp\t/);
      for (const line of f.calls().trim().split('\n')) {
        const config = line.split('\t')[0].slice(7);
        if (config.startsWith(f.root)) assert.ok(!existsSync(config), config);
      }
      assert.match(r.stdout, /[Cc]hannel.*customer/);
    } finally {
      f.clean();
    }
  });
  if (lang === 'ps1')
    check('generated helper forwards remaining upgrade args after image', () => {
      const f = fixture(lang);
      try {
        assert.equal(f.install().status, 0);
        const extra = ['--change-channel', 'acme', '--check', '--privileged'];
        const r = f.invoke(join(f.dir, 'haive.ps1'), ['upgrade', ...extra, '-Version', '10.0.0']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const argv = f.calls().trim().split('\n').at(-1).split('\t');
        const imageAt = argv.indexOf('ghcr.io/martinambrus/haive-updater:10.0.0');
        assert.ok(imageAt > 0);
        assert.deepEqual(argv.slice(-extra.length), extra);
        for (const arg of extra) {
          assert.ok(argv.indexOf(arg) > imageAt, `${arg} must be an updater argument`);
        }
      } finally {
        f.clean();
      }
    });
  check('generated helper exports config and sends channel updater argv', () => {
    const f = fixture(lang);
    try {
      assert.equal(f.install().status, 0);
      const helper = join(f.dir, lang === 'sh' ? 'haive' : 'haive.ps1');
      const r = f.invoke(
        helper,
        lang === 'sh'
          ? ['upgrade', '--version', 'v10.0.0', '--force']
          : ['upgrade', '-Version', 'v10.0.0', '-ForceDrain'],
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const call = f.calls().trim().split('\n').at(-1);
      for (const value of [
        '--channel',
        'customer',
        '--manifest-image',
        `${registry}/haive-customer-release:10.0.0`,
        '--version',
        '10.0.0',
        'DOCKER_CONFIG=/install/.docker',
        'DOCKER_HOST=unix:///var/run/docker.sock',
        `HAIVE_INSTALL_DIR_HOST=${f.dir}`,
        '--force',
      ])
        assert.ok(call.split('\t').includes(value), value);
      assert.ok(!call.split('\t').includes('--manifest'));
      const argv = call.split('\t').slice(1);
      const imageAt = argv.indexOf('ghcr.io/martinambrus/haive-updater:10.0.0');
      assert.ok(imageAt > 0);
      const hostAt = argv.indexOf('DOCKER_HOST=unix:///var/run/docker.sock');
      assert.ok(hostAt > 0 && hostAt < imageAt);
      assert.equal(argv[hostAt - 1], '-e');
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-e') assert.ok(i < imageAt, `docker env option at ${i} after image`);
        if (
          [
            '--channel',
            '--manifest-image',
            '--version',
            '--install-dir',
            '--registry',
            '--postgres-volume',
            '--snapshot-host-dir',
            '--force',
          ].includes(argv[i])
        )
          assert.ok(i > imageAt, `updater option ${argv[i]} before image`);
      }
      const up = f.invoke(helper, ['pull']);
      assert.equal(up.status, 0);
      assert.ok(f.calls().trim().split('\n').at(-1).startsWith(`config=${f.dir}/.docker\t`));
    } finally {
      f.clean();
    }
  });
  check('uninstall removes credential directory', () => {
    const f = fixture(lang);
    try {
      assert.equal(f.install().status, 0);
      const r = f.invoke(join(f.dir, `uninstall.${lang}`), [f.flag('yes')]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(!existsSync(join(f.dir, '.docker')));
    } finally {
      f.clean();
    }
  });
  check('public output and upgrade argv identical to base', (t) => {
    if (skipBaseline) {
      t.skip('baseline belongs to platform installer-controls, explicitly excluded here');
      return;
    }
    const base = spawnSync('git', ['show', '1f311d7c9:install/install.' + lang], {
      cwd: repo,
      encoding: 'utf8',
    });
    if (base.status !== 0) {
      assert.ok(!process.env.CI, 'CI public baseline requires full git history');
      t.skip('public baseline comparison requires history; platform installer-controls fetches it');
      return;
    }
    const f = fixture(lang, { publicInstall: true });
    const old = fixture(lang, { publicInstall: true, source: base.stdout, installDir: f.dir });
    // Both versions run on the same simulated host, inside this test's private root.
    for (const key of ['DOCKER_CONFIG', 'HOME', 'USERPROFILE']) old.env[key] = f.env[key];
    try {
      const oldCheck = old.install([old.flag('check')]);
      const currentCheck = f.install([f.flag('check')]);
      assert.equal(oldCheck.status, 0);
      assert.equal(currentCheck.status, 0);
      assert.equal(currentCheck.stdout, oldCheck.stdout, 'public check output');
      const installed = old.install();
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const names = ['.env', lang === 'sh' ? 'haive' : 'haive.ps1', `uninstall.${lang}`];
      const expected = Object.fromEntries(
        names.map((name) => {
          let bytes = readFileSync(join(f.dir, name));
          if (lang === 'ps1' && name === names[1]) {
            const before = bytes.toString();
            const after = before
              .replace(
                "      '-e', \"COMPOSE_PROJECT_NAME=$($e['COMPOSE_PROJECT_NAME'])\",",
                "      '-e', \"COMPOSE_PROJECT_NAME=$($e['COMPOSE_PROJECT_NAME'])\",\n      '-e', \"HAIVE_INSTALL_ID=$($e['HAIVE_INSTALL_ID'])\",",
              )
              .replace(
                "      '--snapshot-host-dir', \"$($e['HAIVE_INSTALL_DIR_HOST'])/snapshots\",\n      '-e', \"HAIVE_INSTALL_ID=$($e['HAIVE_INSTALL_ID'])\"",
                "      '--snapshot-host-dir', \"$($e['HAIVE_INSTALL_DIR_HOST'])/snapshots\"",
              );
            assert.notEqual(after, before);
            bytes = Buffer.from(after);
          }
          if (name === names[1]) bytes = Buffer.from(approvedPublicSecrets(lang, bytes.toString()));
          return [name, bytes];
        }),
      );
      const upgradeArgs =
        lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'];
      assert.equal(old.invoke(join(f.dir, names[1]), upgradeArgs).status, 0);
      let expectedArgv = old.calls().trim().split('\n').at(-1);
      if (lang === 'ps1') {
        const argv = expectedArgv.split('\t');
        assert.deepEqual(argv.splice(-2), ['-e', 'HAIVE_INSTALL_ID=unit']);
        argv.splice(
          argv.indexOf('COMPOSE_PROJECT_NAME=unit') + 1,
          0,
          '-e',
          'HAIVE_INSTALL_ID=unit',
        );
        expectedArgv = argv.join('\t');
      }
      expectedArgv = expectedArgv
        .split('\t')
        .map((arg) =>
          arg.startsWith('DATABASE_URL=')
            ? 'DATABASE_URL'
            : arg.startsWith('CONFIG_ENCRYPTION_KEY=')
              ? 'CONFIG_ENCRYPTION_KEY'
              : arg,
        )
        .join('\t');
      rmSync(f.dir, { recursive: true, force: true });
      const current = f.install();
      assert.equal(current.status, 0, current.stdout + current.stderr);
      for (const name of names) {
        let actual = readFileSync(join(f.dir, name));
        if (lang === 'sh' && name === 'haive') {
          // The new branch has its own executable controls above. Keep the old
          // helper and upgrade comparison exact everywhere outside that addition.
          actual = Buffer.from(
            actual
              .toString()
              .replace(/^  recover-admin\)\n[\s\S]*?^    ;;\n/m, '')
              .replace('|recover-admin --email <addr> [--user-id <id>]', ''),
          );
        }
        assert.deepEqual(actual, expected[name], name);
      }
      assert.equal(f.invoke(join(f.dir, names[1]), upgradeArgs).status, 0);
      assert.equal(f.calls().trim().split('\n').at(-1), expectedArgv);
      assert.ok(!f.calls().includes('\tlogin\t'));
    } finally {
      f.clean();
      old.clean();
    }
  });
}
