import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile, symlink, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { logger } from '@haive/shared';
import { fetchModuleSource, sourceFetchError } from '../src/modules/source-fetch.js';

const git = vi.hoisted(() => vi.fn());
vi.mock('../src/repo/git-exec.js', () => ({ gitRun: git }));
const source = {
  id: '00000000-0000-4000-8000-000000000337',
  moduleId: 'alpha',
  kind: 'git' as const,
  url: 'https://example.com/alpha.git',
  ref: 'main',
  resolvedSha: null,
};
const sha = 'a'.repeat(40);
afterEach(() => {
  for (const root of new Set(git.mock.calls.map(([cwd]) => dirname(cwd))))
    logger.info({ removed: root }, 'T337 fetch temp cleanup');
  vi.unstubAllEnvs();
  git.mockReset();
});
function setup() {
  vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
  vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
  git.mockImplementation(async (cwd: string, args: string[]) => {
    if (args.includes('get-url')) return { code: 0, stdout: source.url + '\n', stderr: '' };
    if (args.includes('ls-remote'))
      return { code: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: '' };
    if (args.includes('checkout')) {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: '@haive-module/alpha',
          exports: { './manifest': './src/manifest.js' },
        }),
      );
      await writeFile(join(cwd, 'value'), 'pinned');
    }
    return { code: 0, stdout: args.includes('rev-parse') ? sha + '\n' : '', stderr: '' };
  });
}
describe('fetch and pin a module source', () => {
  it.each(['link', 'size', 'name'])('refuses a fetched tree with an invalid %s', async (kind) => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown) => {
      const result = await previous(cwd, args, env);
      if (args.includes('checkout')) {
        if (kind === 'link') await symlink('/etc', join(cwd, 'escape'));
        if (kind === 'size') await truncate(join(cwd, 'value'), 65 * 1024 * 1024);
        if (kind === 'name')
          await writeFile(
            join(cwd, 'package.json'),
            JSON.stringify({ name: '@haive-module/wrong' }),
          );
      }
      return result;
    });
    const pin = vi.fn();
    await expect(fetchModuleSource(source, null, pin)).rejects.toThrow();
    expect(pin).not.toHaveBeenCalled();
  });
  it('resolves an annotated tag to its peeled commit', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown) =>
      args.includes('ls-remote')
        ? {
            code: 0,
            stdout: `${'b'.repeat(40)}\trefs/tags/v1\n${sha}\trefs/tags/v1^{}\n`,
            stderr: '',
          }
        : previous(cwd, args, env),
    );
    expect(await fetchModuleSource({ ...source, ref: 'v1' }, null, vi.fn())).toBe(sha);
  });
  it('serves the token only over the credential helper protocol for the stored HTTPS host', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown) => {
      if (args.includes('ls-remote')) {
        const helper = join(dirname(cwd), 'credential.cjs');
        expect(await readFile(helper, 'utf8')).not.toContain('private-token');
        expect(JSON.stringify({ args, env })).not.toContain('private-token');
        const ask = (host: string) =>
          new Promise<string>((resolve, reject) => {
            const child = execFile('node', [helper, 'get'], (error, stdout) =>
              error ? reject(error) : resolve(stdout),
            );
            child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
          });
        expect(await ask('example.com')).toContain('password=private-token');
        expect(await ask('another.example')).not.toContain('private-token');
      }
      return previous(cwd, args, env);
    });
    await fetchModuleSource(source, 'private-token', vi.fn());
  });
  it('scrubs a failing remote before it reaches any caller', async () => {
    setup();
    git.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'private-token https://u:p@example.com/a',
    });
    try {
      await fetchModuleSource(source, 'private-token', vi.fn());
      throw new Error('unexpected success');
    } catch (error) {
      expect(String(error)).not.toMatch(/private-token|u:p/);
    }
  });
  it('resolves a qualified branch, pins that SHA, excludes .git and removes the private directory', async () => {
    setup();
    let temporary = '';
    const pin = vi.fn(async (root: string) => {
      temporary = root;
      expect(JSON.parse(await readFile(join(root, '.haive-source.json'), 'utf8'))).toMatchObject({
        sha,
        kind: 'git',
      });
      await expect(access(join(root, '.git'))).rejects.toThrow();
    });
    expect(await fetchModuleSource(source, 'private-token', pin)).toBe(sha);
    expect(pin).toHaveBeenCalledOnce();
    await expect(access(temporary)).rejects.toThrow();
    const calls = JSON.stringify(git.mock.calls);
    expect(calls).toContain('refs/heads/main');
    expect(calls).toContain('--end-of-options');
    expect(calls).toContain(sha);
    expect(calls).not.toContain('private-token');
  });
  it('re-fetches the recorded SHA without re-resolving the branch', async () => {
    setup();
    await fetchModuleSource({ ...source, resolvedSha: sha }, null, vi.fn());
    expect(git.mock.calls.some(([, args]) => args.includes('ls-remote'))).toBe(false);
  });
  it.each(['--upload-pack=bad', 'refs/heads/main', 'main~1', 'main:other', '+main', 'bad.lock'])(
    'refuses invalid ref %s before network IO',
    async (ref) => {
      setup();
      await expect(fetchModuleSource({ ...source, ref }, null, vi.fn())).rejects.toThrow(/ref/i);
      expect(git).not.toHaveBeenCalled();
    },
  );
  it('refuses a source checkout and an unset directory', async () => {
    setup();
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', '');
    await expect(fetchModuleSource(source, null, vi.fn())).rejects.toThrow(/published/i);
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '');
    await expect(fetchModuleSource(source, null, vi.fn())).rejects.toThrow(
      /HAIVE_OWN_MODULES_HOST_DIR/,
    );
    expect(git).not.toHaveBeenCalled();
  });
  it('removes the private directory after a pin failure and scrubs secrets and URL userinfo', async () => {
    setup();
    let temporary = '';
    await expect(
      fetchModuleSource(source, 'private-token', async (root) => {
        temporary = root;
        throw new Error('private-token https://user:password@example.com/a');
      }),
    ).rejects.toThrow();
    await expect(access(temporary)).rejects.toThrow();
    const message = sourceFetchError(
      new Error('private-token https://user:password@example.com/a'),
      'private-token',
    );
    expect(message).not.toMatch(/private-token|password|user:/);
  });
});
