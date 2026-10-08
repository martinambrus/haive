import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExec, gitRun } from '../../../repo/git-exec.js';
import { scanForCredentials, scanTextForCredentials } from './_credential-scan.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'haive-credential-scan-'));
  roots.push(root);
  await gitExec(['init'], { cwd: root });
  return root;
}

describe('credential candidates', () => {
  it('finds the three credential shapes in a vendored bunyip build config, without leaking values', () => {
    const file = 'libraries/plupload/build/bunyip.config.js';
    const authToken = 'a9'.repeat(8);
    const text = [
      'module.exports = {',
      '  testswarm: {',
      "    username: 'maintainer',",
      `    authToken: '${authToken}',`,
      '  },',
      '  browserstack: {',
      "    password: 'RealLookingSyntheticPassword',",
      '  },',
      '  tunnel: {',
      "    secret: 'SyntheticKiteSecret',",
      '  }',
      '}',
    ].join('\n');
    const hits = scanTextForCredentials(file, text);
    expect(hits.map((hit) => hit.line)).toEqual([4, 7, 10]);
    expect(hits.every((hit) => hit.kind === 'credential assignment')).toBe(true);
    for (const value of [authToken, 'RealLookingSyntheticPassword', 'SyntheticKiteSecret']) {
      expect(JSON.stringify(hits)).not.toContain(value);
    }
  });

  it('supports PHP, JSON and quoted env assignments without making a finding verdict', () => {
    const hits = scanTextForCredentials(
      'fixture',
      [
        "'smtp_password' => 'SyntheticAccountPassword',",
        '"api_key": "SyntheticApiCredential",',
        'AUTH_TOKEN="SyntheticAuthCredential"',
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it('keeps private keys, provider formats and URL passwords on the candidate list', () => {
    const hits = scanTextForCredentials(
      'fixture',
      [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        `const value = "ghp_${'a'.repeat(36)}";`,
        'postgres://account:SyntheticUrlPassword@remote.example/db',
        'postgres://account:p@remote.example/db',
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.kind)).toEqual([
      'private key',
      'provider key',
      'credential URL',
      'credential URL',
    ]);
  });

  it('recognizes password-only credential URLs without nominating empty passwords', () => {
    const text = [
      'REDIS_URL=redis://:hunter2@cache.example',
      'REDIS_URL="rediss://:p@cache.example"',
      'REDIS_URL=redis://:@cache.example',
      'REDIS_URL=redis://:process.env.PASSWORD@cache.example',
    ].join('\n');
    expect(scanTextForCredentials('vendor/config', text)).toEqual([
      { file: 'vendor/config', line: 1, kind: 'credential URL' },
      { file: 'vendor/config', line: 2, kind: 'credential URL' },
    ]);
  });

  it('includes unquoted dotenv and YAML credentials while excluding references and expressions', () => {
    const hits = scanTextForCredentials(
      'build/config.env',
      [
        'PASSWORD=SyntheticEnvCredential',
        '  password: SyntheticYamlCredential # account password',
        'AUTH_TOKEN=SyntheticAuthCredential;',
        'password: process.env.PASSWORD,',
        'token: import.meta.env.AUTH_TOKEN',
        'secret: ${ENV_SECRET}',
        'password: your-password-here',
        'password: undefined',
        'password: generatePassword()',
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
    expect(hits.every((hit) => hit.kind === 'credential assignment')).toBe(true);
    expect(JSON.stringify(hits)).not.toContain('Synthetic');
  });

  it('recognizes bracketed string and symbol credential assignments', () => {
    const text = [
      "$config['password'] = 'hunter2';",
      "settings[:api_key] = 'real-key'",
      'settings["AUTH_TOKEN_PRODUCTION"] = "short";',
      'settings[:secret] = short',
      'settings["tokenizer"] = "bert-base";',
      '$config["password"] = process.env.PASSWORD;',
    ].join('\n');
    expect(scanTextForCredentials('vendor/config', text).map((hit) => hit.line)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('does not discard short named credentials before the model can judge them', () => {
    const hits = scanTextForCredentials(
      'vendor/config',
      [
        'PASSWORD=hunter2',
        'password: s3cr3t',
        "password: 'pw'",
        'PASSWORD=p',
        'PASSWORD=',
        "password: ''",
        'password: false',
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4]);
  });

  it('recognizes suffixed credential names in both quoted and unquoted assignments', () => {
    const hits = scanTextForCredentials(
      'config',
      [
        'SECRET_KEY_BASE=SyntheticBaseCredential',
        'CLIENT_SECRET_VALUE=SyntheticClientCredential',
        'AUTH_TOKEN_PRODUCTION=SyntheticProductionCredential',
        '"apiKeyValue": "SyntheticApiCredential",',
        'secretKeyValue: `SyntheticSigningCredential`,',
        'AUTH_TOKEN_PRODUCTION=process.env.AUTH_TOKEN',
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not nominate unrelated words containing credential-name substrings', () => {
    const text = [
      'tokenizer: "bert-base",',
      'passwordless_mode: "optional",',
      'secretary: "alice",',
      'AUTH_TOKEN_PRODUCTION=short',
      'secretKeyValue: "short",',
      'APIKeyValue: "short",',
    ].join('\n');
    expect(scanTextForCredentials('config', text).map((hit) => hit.line)).toEqual([4, 5, 6]);
  });

  it('rejects a long repeated credential-like identifier without an assignment', () => {
    expect(scanTextForCredentials('generated.js', 'token-'.repeat(80_000))).toEqual([]);
    expect(scanTextForCredentials('generated.js', 'a-'.repeat(160_000) + '://account:p')).toEqual(
      [],
    );
  });

  it('does not persist binary content or nominate obvious placeholders/environment references', () => {
    expect(scanTextForCredentials('binary', "\0password: 'SyntheticPassword'")).toEqual([]);
    expect(
      scanTextForCredentials(
        'sample',
        [
          "password: 'your-password-here',",
          "secret: '${ENV_SECRET}',",
          "apiKey: 'AKIAIOSFODNN7EXAMPLE',",
          'password: process.env.PASSWORD,',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('tracked credential inventory', () => {
  it('includes ignored-but-tracked dependency/build files at any depth and refuses links', async () => {
    const root = await repo();
    const files = [
      'libraries/plupload/build/bunyip.config.js',
      'vendor/a/tests/deep/one/two/three/four/five/six/creds.txt',
      'dist/example.json',
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "password: 'SyntheticTrackedPassword'");
    }
    await writeFile(path.join(root, '.gitignore'), 'vendor/\nbuild/\ndist/\n');
    await writeFile(path.join(root, 'untracked.env'), "PASSWORD='SyntheticUntrackedPassword'");
    await symlink(path.join(root, files[0]!), path.join(root, 'linked.js'));
    await gitExec(['add', '-f', '--', ...files, 'linked.js'], { cwd: root });
    const scan = await scanForCredentials(root, 20);
    expect(scan.hits.map((hit) => hit.file).sort()).toEqual(files.sort());
    expect(scan.files).toBe(4);
    expect(scan.unreadable).toBe(1);
    expect(JSON.stringify(scan)).not.toContain('SyntheticTrackedPassword');
    expect(JSON.stringify(scan)).not.toContain('SyntheticUntrackedPassword');
  });

  it('reports exact omissions and spreads the cap across files before taking more from one', async () => {
    const root = await repo();
    await writeFile(
      path.join(root, 'a.js'),
      Array(5).fill("password: 'SyntheticPassword'").join('\n'),
    );
    await writeFile(path.join(root, 'z.js'), "authToken: 'SyntheticToken'");
    await gitExec(['add', '--', 'a.js', 'z.js'], { cwd: root });
    const scan = await scanForCredentials(root, 2);
    expect(scan.hits.map((hit) => hit.file)).toEqual(['a.js', 'z.js']);
    expect(scan.omitted).toBe(4);
  });

  it.each(['\n', '====', '\u0085', '\u2028'])(
    'keeps prompt-unsafe paths (%j) from exhausting the retained cap',
    async (unsafe) => {
      const root = await repo();
      const files = [0, 1, 2].map((i) => `a${i}${unsafe}.env`);
      files.push('z.env');
      for (const file of files) await writeFile(path.join(root, file), 'PASSWORD=p\n');
      await gitExec(['add', '--', ...files], { cwd: root });
      const scan = await scanForCredentials(root, 2);
      expect(scan.hits).toEqual([{ file: 'z.env', line: 1, kind: 'credential assignment' }]);
      expect(scan.omitted).toBe(3);
      expect(scan.files).toBe(4);
    },
  );

  it('keeps unrelated key substrings from crowding credentials out of the cap', async () => {
    const root = await repo();
    const content = 'tokenizer: "bert-base"\npasswordless_mode: "optional"\nsecretary: "alice"\n';
    for (const file of ['a.json', 'b.json', 'c.json'])
      await writeFile(path.join(root, file), content);
    await writeFile(path.join(root, 'z.env'), 'AUTH_TOKEN_PRODUCTION=short\n');
    await gitExec(['add', '--all'], { cwd: root });
    const scan = await scanForCredentials(root, 1);
    expect(scan.hits).toEqual([{ file: 'z.env', line: 1, kind: 'credential assignment' }]);
    expect(scan.omitted).toBe(0);
  });

  it('reports bounded reads and still inspects the prefix of a large file', async () => {
    const root = await repo();
    await writeFile(
      path.join(root, 'large.txt'),
      "password: 'SyntheticPassword'\n" + ' '.repeat(600_000),
    );
    await gitExec(['add', '--', 'large.txt'], { cwd: root });
    const scan = await scanForCredentials(root, 10);
    expect(scan.truncated).toBe(1);
    expect(scan.hits).toHaveLength(1);
  });

  it('counts millions of matches under a 64 MiB heap limit while retaining only the cap', async () => {
    const root = await repo();
    const linesPerFile = 65_536;
    const fileCount = 32;
    const content = 'token=a\n'.repeat(linesPerFile);
    const files = Array.from(
      { length: fileCount },
      (_, i) => `file-${String(i).padStart(2, '0')}.env`,
    );
    for (const file of files) await writeFile(path.join(root, file), content);
    await gitExec(['add', '--', ...files], { cwd: root });
    const moduleUrl = new URL('./_credential-scan.ts', import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--max-old-space-size=64',
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { scanForCredentials } from ${JSON.stringify(moduleUrl)};
       const scan = await scanForCredentials(${JSON.stringify(root)}, 200);
       process.stdout.write(JSON.stringify(scan));`,
      ],
      { timeout: 35_000 },
    );
    const scan = JSON.parse(stdout) as Awaited<ReturnType<typeof scanForCredentials>>;
    expect(scan.files).toBe(fileCount);
    expect(scan.hits).toHaveLength(200);
    expect(scan.omitted).toBe(fileCount * linesPerFile - 200);
    expect(scan.hits.slice(0, fileCount).map((hit) => hit.file)).toEqual(files);
    expect(scan.hits.at(-1)).toMatchObject({ file: 'file-07.env', line: 7 });
  }, 45_000);

  it.each([
    { count: 100_001, prefix: 'vendor/' },
    { count: 5_000, prefix: `vendor/${'a/'.repeat(450)}` },
  ])(
    'scans oversized inventories under a 64 MiB heap (%j)',
    async ({ count, prefix }) => {
      const root = await repo();
      const blob = await gitRun(root, ['hash-object', '-w', '--stdin'], undefined, {
        input: Buffer.from('token=a\n'),
      });
      expect(blob.code).toBe(0);
      const input = Buffer.from(
        Array.from(
          { length: count },
          (_, i) => `100644 ${blob.stdout.trim()}\t${prefix}file-${i}.env\n`,
        ).join('') + `100644 ${blob.stdout.trim()}\tz.env\n`,
      );
      const index = await gitRun(root, ['update-index', '--index-info'], undefined, { input });
      expect(index.code).toBe(0);
      await writeFile(path.join(root, 'z.env'), 'token=a\n');
      const moduleUrl = new URL('./_credential-scan.ts', import.meta.url).href;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--max-old-space-size=64',
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import { scanForCredentials } from ${JSON.stringify(moduleUrl)};
         const scan = await scanForCredentials(${JSON.stringify(root)}, 200);
         process.stdout.write(JSON.stringify(scan));`,
        ],
        { timeout: 240_000 },
      );
      const scan = JSON.parse(stdout) as Awaited<ReturnType<typeof scanForCredentials>>;
      expect(scan.files).toBe(count + 1);
      expect(scan.unreadable).toBe(count);
      expect(scan.hits).toEqual([{ file: 'z.env', line: 1, kind: 'credential assignment' }]);
    },
    255_000,
  );

  it.each([{ maxFiles: 2 }, { maxPathBytes: 10 }])(
    'keeps prior candidates when a total-work budget stops the scan (%j)',
    async (limits) => {
      const root = await repo();
      for (const file of ['a.env', 'b.env', 'c.env'])
        await writeFile(path.join(root, file), 'token=a\n');
      await gitExec(['add', '--all'], { cwd: root });
      const scan = await scanForCredentials(root, 10, () => {}, limits);
      expect(scan.limited).toBe(true);
      expect(scan.hits.map((hit) => hit.file)).toEqual(['a.env', 'b.env']);
      expect(scan.files).toBe(2);
    },
  );

  it('ends a timed-out inventory without losing already completed reads', async () => {
    const root = await repo();
    for (let i = 0; i < 40; i++) await writeFile(path.join(root, `file-${i}.env`), 'token=a\n');
    await gitExec(['add', '--all'], { cwd: root });
    const scan = await scanForCredentials(root, 10, () => {}, { timeoutMs: 1 });
    expect(scan.limited).toBe(true);
    expect(scan.files).toBeLessThan(40);
  });

  it('does not read another file through a non-UTF-8 path replacement', async () => {
    const root = await repo();
    const rawPath = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff])]);
    await writeFile(rawPath, 'token=a\n');
    await writeFile(path.join(root, 'bad-\ufffd'), 'nothing here\n');
    await writeFile(path.join(root, 'utf8-\u00e9.env'), 'token=a\n');
    await writeFile(path.join(root, '\ufeffbom.env'), 'token=a\n');
    await gitExec(['add', '--all'], { cwd: root });
    const scan = await scanForCredentials(root, 10);
    expect(scan.files).toBe(4);
    expect(scan.unreadable).toBe(1);
    expect(scan.hits).toEqual([
      { file: 'utf8-\u00e9.env', line: 1, kind: 'credential assignment' },
      { file: '\ufeffbom.env', line: 1, kind: 'credential assignment' },
    ]);
  });

  it('closes the streamed inventory when cancelled during parsing', async () => {
    const root = await repo();
    for (let i = 0; i < 40; i++) await writeFile(path.join(root, `file-${i}.env`), 'token=a\n');
    await gitExec(['add', '--all'], { cwd: root });
    let checks = 0;
    await expect(
      scanForCredentials(root, 10, () => {
        if (++checks === 20) throw new Error('cancelled during inventory');
      }),
    ).rejects.toThrow('cancelled during inventory');
  });

  it('propagates cancellation rather than completing a partial scan', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'a.js'), "password: 'SyntheticPassword'");
    await gitExec(['add', '--', 'a.js'], { cwd: root });
    await expect(
      scanForCredentials(root, 10, () => {
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
  });
});
