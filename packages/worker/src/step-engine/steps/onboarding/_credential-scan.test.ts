import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExec } from '../../../repo/git-exec.js';
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
      ].join('\n'),
    );
    expect(hits.map((hit) => hit.kind)).toEqual(['private key', 'provider key', 'credential URL']);
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
