import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
prev=; out=
for arg do [ "$prev" != -o ] || out=$arg; prev=$arg; done
case "$out" in *docker-compose*) printf 'services: {}\\n' > "$out" ;; esac
exit 0
`;
function fixture(lang, { publicInstall = false, data = manifest, fail = '', source } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'channel-installer-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const dir = join(root, 'install');
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
  writeFileSync(script, source ?? readFileSync(join(repo, 'install', `install.${lang}`), 'utf8'));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAIVE_GPU: 'cpu',
    HAIVE_REGISTRY_TOKEN: token,
    CASE_ROOT: root,
    CALLS: calls,
    FAIL_AT: fail,
    TMPDIR: root,
  };
  const invoke = (file, args) => {
    if (lang === 'sh') return spawnSync('sh', [file, ...args], { env, encoding: 'utf8' });
    // Windows-only host probes/downloads are replaced; all installer and generated helper code runs.
    const wrapper = join(root, 'invoke.ps1');
    writeFileSync(
      wrapper,
      `function Get-CimInstance { [pscustomobject]@{TotalPhysicalMemory=16GB} }\nfunction Get-Date { '2000-01-01T00:00:00Z' }\nfunction Invoke-WebRequest { param($Uri,$OutFile,$UseBasicParsing,$Method); if($OutFile){ [IO.File]::WriteAllText($OutFile, "services: {}\\n") } }\n& '${file.replaceAll("'", "''")}' ${args.map((x) => `'${x.replaceAll("'", "''")}'`).join(' ')}\n`,
    );
    if (hostPwsh)
      return spawnSync('pwsh', ['-NoProfile', '-File', wrapper], {
        env: { ...env, USERPROFILE: '/tmp' },
        encoding: 'utf8',
      });
    const pass = Object.entries({
      ...env,
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
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '-v',
        `${root}:${root}`,
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
  const install = (extra = []) =>
    invoke(script, [
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
      ...extra,
    ]);
  return {
    root,
    dir,
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
      lang === 'ps1' && !hostPwsh && !containerPwsh
        ? 'pwsh unavailable; pull the existing harness PowerShell image or run in CI'
        : false,
  };
  const check = (name, fn) => test(`${lang}: ${name}`, options, fn);
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
    ['channel', ['BAD', '-bad', 'bad-', 'a'.repeat(33)]],
    ['channel-registry', ['https://bad', 'bad/', 'Bad', 'bad,,x']],
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
    ['malformed JSON', '{"channel":', ''],
    ['missing pin', { ...manifest, images: { ...pins, web: null } }, ''],
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
      const up = f.invoke(helper, ['ps']);
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
  check('public output and upgrade argv identical to base', () => {
    const base = spawnSync('git', ['show', '1f311d7c9:install/install.' + lang], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(base.status, 0);
    const f = fixture(lang, { publicInstall: true });
    const old = fixture(lang, { publicInstall: true, source: base.stdout });
    try {
      assert.equal(old.install().status, 0);
      assert.equal(f.install().status, 0);
      for (const name of ['.env', lang === 'sh' ? 'haive' : 'haive.ps1', `uninstall.${lang}`]) {
        const normalize = (s, dir) =>
          s
            .replaceAll(dir, '<INSTALL>')
            .replace(/^# Haive install.*$/m, '<DATE>')
            .replace(/^(CONFIG_ENCRYPTION_KEY|JWT_SECRET|POSTGRES_PASSWORD)=.*$/gm, '$1=<SECRET>');
        assert.equal(
          normalize(readFileSync(join(f.dir, name), 'utf8'), f.dir),
          normalize(readFileSync(join(old.dir, name), 'utf8'), old.dir),
          name,
        );
      }
      for (const t of [f, old]) {
        const r = t.invoke(
          join(t.dir, lang === 'sh' ? 'haive' : 'haive.ps1'),
          lang === 'sh' ? ['upgrade', '--version', '10.0.0'] : ['upgrade', '-Version', '10.0.0'],
        );
        assert.equal(r.status, 0, r.stdout + r.stderr);
      }
      const norm = (s, dir) => s.trim().split('\n').at(-1).replaceAll(dir, '<INSTALL>');
      assert.equal(norm(f.calls(), f.dir), norm(old.calls(), old.dir));
      assert.ok(!f.calls().includes('\tlogin\t'));
    } finally {
      f.clean();
      old.clean();
    }
  });
}
