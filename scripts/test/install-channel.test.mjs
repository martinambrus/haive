import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
case "$1" in
 login) cat > "$CASE_ROOT/stdin"; [ "$FAIL_AT" != login ] || exit 1; printf '{"auths":{}}' > "$DOCKER_CONFIG/config.json" ;;
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
[ "$FAIL_AT" != bundle ] || exit 1
prev=; out=
for arg do [ "$prev" != -o ] || out=$arg; prev=$arg; done
case "$out" in *docker-compose*) printf 'services: {}\\n' > "$out" ;; esac
exit 0
`;
function fixture(
  lang,
  { publicInstall = false, data = manifest, fail = '', source, installDir } = {},
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
  };
  const invoke = (file, args) => {
    const childEnv = { ...env, EXPECT_CHANNEL: file === script ? env.EXPECT_CHANNEL : '0' };
    if (lang === 'sh')
      return spawnSync('sh', [file, ...args], { cwd: root, env: childEnv, encoding: 'utf8' });
    // Windows-only host probes/downloads are replaced; all installer and generated helper code runs.
    const wrapper = join(root, 'invoke.ps1');
    writeFileSync(
      wrapper,
      `$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\nfunction Move-Item { param($LiteralPath,$Destination); Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters; if($env:FAIL_AT -eq 'unprotect-move'){ & chmod 755 $Destination; & chmod 644 (Join-Path $Destination 'config.json') } }\nfunction New-Item { param($ItemType,$Path,[switch]$Force); if($Path -like '*/snapshots' -and $env:FAIL_AT -in @('mkdir','pipeline-stop')) { if($env:FAIL_AT -eq 'pipeline-stop'){ throw [System.Management.Automation.PipelineStoppedException]::new() }; throw 'post-verification mkdir failure' }; Microsoft.PowerShell.Management\\New-Item @PSBoundParameters }\nfunction Get-CimInstance { [pscustomobject]@{TotalPhysicalMemory=16GB} }\nfunction Get-Date { '2000-01-01T00:00:00Z' }\nfunction Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$Method); if($OutFile){ if($env:FAIL_AT -eq 'bundle'){ throw 'bundle failure' }; [IO.File]::WriteAllText($OutFile, "services: {}\\n") } }\n& '${file.replaceAll("'", "''")}' ${args.map((x) => (/^--?(version|dir|install-id|installId|no-start|noStart|channel|channel-registry|registry-user|channelRegistry|registryUser|check|force|yes|ForceDrain)$/i.test(x) ? x : `'${x.replaceAll("'", "''")}'`)).join(' ')}\nexit $LASTEXITCODE\n`,
    );
    if (hostPwsh)
      return spawnSync('pwsh', ['-NoProfile', '-File', wrapper], {
        cwd: root,
        env: { ...childEnv, USERPROFILE: '/tmp' },
        encoding: 'utf8',
      });
    const pass = Object.entries({
      ...childEnv,
      PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      USERPROFILE: '/tmp',
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
        ].includes(key),
      )
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return spawnSync(
      'docker',
      [
        'run',
        '--rm',
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
      flag('no-start'),
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
  for (const [name, data, fail] of [
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
    ['escaped-quote key', JSON.stringify(manifest).replace('{', '{"escaped\\\"key":0,'), ''],
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
        `HAIVE_INSTALL_DIR_HOST=${f.dir}`,
        '--force',
      ])
        assert.ok(call.split('\t').includes(value), value);
      assert.ok(!call.split('\t').includes('--manifest'));
      const argv = call.split('\t').slice(1);
      const imageAt = argv.indexOf('ghcr.io/martinambrus/haive-updater:10.0.0');
      assert.ok(imageAt > 0);
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
        names.map((name) => [name, readFileSync(join(f.dir, name))]),
      );
      const upgradeArgs =
        lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'];
      assert.equal(old.invoke(join(f.dir, names[1]), upgradeArgs).status, 0);
      const expectedArgv = old.calls().trim().split('\n').at(-1);
      rmSync(f.dir, { recursive: true, force: true });
      const current = f.install();
      assert.equal(current.status, 0, current.stdout + current.stderr);
      for (const name of names)
        assert.deepEqual(readFileSync(join(f.dir, name)), expected[name], name);
      assert.equal(f.invoke(join(f.dir, names[1]), upgradeArgs).status, 0);
      assert.equal(f.calls().trim().split('\n').at(-1), expectedArgv);
      assert.ok(!f.calls().includes('\tlogin\t'));
    } finally {
      f.clean();
      old.clean();
    }
  });
}
