import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile, symlink, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { logger } from '@haive/shared';
import { fetchModuleSource, sourceFetchError } from '../src/modules/source-fetch.js';

const git = vi.hoisted(() => vi.fn());
const image = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/source-pin.js', () => ({
  resolveWorkerImage: image,
  pinModuleTree: vi.fn(),
}));
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
  image.mockResolvedValue('sha256:' + 'c'.repeat(64));
  git.mockImplementation(async (cwd: string, args: string[]) => {
    if (args.includes('get-url')) return { code: 0, stdout: source.url + '\n', stderr: '' };
    if (args.includes('ls-remote'))
      return { code: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: '' };
    if (args.includes('checkout')) {
      await mkdir(join(cwd, '.git', 'objects', 'aa'), { recursive: true });
      await writeFile(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(cwd, '.git', 'objects', 'aa', 'pack'), 'object', { mode: 0o444 });
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
  it('fails image resolution before git or persisting a SHA', async () => {
    setup();
    image.mockRejectedValueOnce(new Error('module_source_worker_image_unavailable'));
    const resolved = vi.fn();
    const pin = vi.fn();
    await expect(fetchModuleSource(source, null, pin, resolved)).rejects.toThrow(
      'module_source_worker_image_unavailable',
    );
    expect(git).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });
  it('aborts an oversized transfer before it completes or checks out', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    let aborted = false;
    let temporary = '';
    git.mockImplementation(
      async (cwd: string, args: string[], env: unknown, io: { signal?: AbortSignal }) => {
        if (args.includes('fetch')) {
          temporary = dirname(cwd);
          await mkdir(join(cwd, '.git', 'objects', 'pack'), { recursive: true });
          const pack = join(cwd, '.git', 'objects', 'pack', 'tmp_pack');
          await writeFile(pack, '');
          await truncate(pack, 65 * 1024 * 1024);
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500);
            io.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
          });
        }
        return previous(cwd, args, env, io);
      },
    );
    const pin = vi.fn();
    await expect(fetchModuleSource(source, null, pin)).rejects.toThrow(
      'Module tree exceeds size limit',
    );
    expect(aborted).toBe(true);
    expect(git.mock.calls.some(([, args]) => args.includes('checkout'))).toBe(false);
    expect(pin).not.toHaveBeenCalled();
    await expect(access(temporary)).rejects.toThrow();
  });
  it('aborts an oversized checkout before completion and removes the expanded tree', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    let aborted = false;
    let completed = false;
    let temporary = '';
    git.mockImplementation(
      async (cwd: string, args: string[], env: unknown, io: { signal?: AbortSignal }) => {
        const result = await previous(cwd, args, env, io);
        if (args.includes('checkout')) {
          temporary = dirname(cwd);
          await truncate(join(cwd, 'value'), 65 * 1024 * 1024);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              completed = true;
              resolve();
            }, 500);
            io.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        return result;
      },
    );
    const pin = vi.fn();
    await expect(fetchModuleSource(source, null, pin)).rejects.toThrow(
      'Module tree exceeds size limit',
    );
    expect(aborted).toBe(true);
    expect(completed).toBe(false);
    expect(pin).not.toHaveBeenCalled();
    await expect(access(temporary)).rejects.toThrow();
  });
  it('counts only the expanded work tree during checkout, excluding fetched git objects', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown, io: unknown) => {
      const result = await previous(cwd, args, env, io);
      if (args.includes('checkout')) {
        await writeFile(join(cwd, '.git', 'objects', 'aa', 'large'), '');
        await truncate(join(cwd, '.git', 'objects', 'aa', 'large'), 40 * 1024 * 1024);
        await truncate(join(cwd, 'value'), 40 * 1024 * 1024);
      }
      return result;
    });
    const pin = vi.fn();
    await expect(fetchModuleSource(source, null, pin)).resolves.toBe(sha);
    expect(pin).toHaveBeenCalledOnce();
  });
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
    const resolved = vi.fn();
    expect(await fetchModuleSource({ ...source, ref: 'v1' }, null, vi.fn(), resolved)).toBe(sha);
    expect(resolved).toHaveBeenCalledWith(sha, 'refs/tags/v1');
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
  it.each(['refs/heads/main', 'refs/tags/v1'])(
    'falls back to the qualified ref %s when object-name fetch is refused',
    async (qualified) => {
      setup();
      const previous = git.getMockImplementation()!;
      git.mockImplementation(async (cwd: string, args: string[], env: unknown) => {
        if (args.includes('ls-remote'))
          return { code: 0, stdout: `${sha}\t${qualified}\n`, stderr: '' };
        if (args.includes('fetch') && args.at(-1) === sha)
          return { code: 1, stdout: '', stderr: 'object wants not supported' };
        return previous(cwd, args, env);
      });
      await expect(
        fetchModuleSource(
          { ...source, ref: qualified.endsWith('v1') ? 'v1' : 'main' },
          null,
          vi.fn(),
        ),
      ).resolves.toBe(sha);
      const fallback = git.mock.calls.find(
        ([, args]) => args.includes('fetch') && args.at(-1) === qualified,
      );
      expect(fallback).toBeDefined();
      expect(fallback![1].slice(-3)).toEqual(['--end-of-options', source.url, qualified]);
    },
  );
  it.each([null, 'refs/tags/v1'])(
    'keeps a pinned tag namespace (%s) when a same-named branch appears',
    async (resolvedRef) => {
      setup();
      const previous = git.getMockImplementation()!;
      let target = '';
      git.mockImplementation(async (cwd: string, args: string[], env: unknown, io: unknown) => {
        if (args.includes('ls-remote'))
          return {
            code: 0,
            stdout: `${'b'.repeat(40)}\trefs/heads/v1\n${'c'.repeat(40)}\trefs/tags/v1\n${sha}\trefs/tags/v1^{}\n`,
            stderr: '',
          };
        if (args.includes('fetch')) {
          target = args.at(-1)!;
          if (target === sha) return { code: 1, stdout: '', stderr: 'object wants not supported' };
        }
        if (args.includes('rev-parse'))
          return {
            code: 0,
            stdout: target === 'refs/tags/v1' ? sha : 'b'.repeat(40),
            stderr: '',
          };
        return previous(cwd, args, env, io);
      });
      const resolved = vi.fn();
      await expect(
        fetchModuleSource(
          { ...source, ref: 'v1', resolvedSha: sha, resolvedRef },
          null,
          vi.fn(),
          resolved,
        ),
      ).resolves.toBe(sha);
      expect(resolved).toHaveBeenCalledWith(sha, 'refs/tags/v1');
    },
  );
  it('keeps the recorded branch namespace when a same-named tag appears', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown, io: unknown) => {
      if (args.includes('ls-remote')) throw new Error('Recorded namespace must not be re-resolved');
      if (args.includes('fetch') && args.at(-1) === sha)
        return { code: 1, stdout: '', stderr: 'object wants not supported' };
      return previous(cwd, args, env, io);
    });
    const resolved = vi.fn();
    await expect(
      fetchModuleSource(
        { ...source, resolvedSha: sha, resolvedRef: 'refs/heads/main' },
        null,
        vi.fn(),
        resolved,
      ),
    ).resolves.toBe(sha);
    expect(resolved).toHaveBeenCalledWith(sha, 'refs/heads/main');
    expect(
      git.mock.calls.filter(([, args]) => args.includes('fetch')).map(([, args]) => args.at(-1)),
    ).toEqual([sha, 'refs/heads/main']);
  });
  it.each([null, 'refs/heads/main', 'refs/tags/main'])(
    'reports a deleted pinned ref consistently with recorded namespace %s',
    async (resolvedRef) => {
      setup();
      const previous = git.getMockImplementation()!;
      git.mockImplementation(async (cwd: string, args: string[], env: unknown, io: unknown) => {
        if (args.includes('ls-remote')) return { code: 0, stdout: '', stderr: '' };
        if (args.includes('fetch'))
          return { code: 128, stdout: '', stderr: "couldn't find remote ref" };
        return previous(cwd, args, env, io);
      });
      const pin = vi.fn();
      const resolved = vi.fn();
      await expect(
        fetchModuleSource({ ...source, resolvedSha: sha, resolvedRef }, null, pin, resolved),
      ).rejects.toThrow('module_source_ref_unavailable: Module branch or tag was not found');
      expect(resolved).not.toHaveBeenCalled();
      expect(pin).not.toHaveBeenCalled();
      expect(git.mock.calls.some(([, args]) => args.includes('checkout'))).toBe(false);
    },
  );
  it.each(['refs/remotes/origin/main', 'refs/heads/other', 'refs/tags/other'])(
    'rejects invalid recorded namespace %s before git',
    async (resolvedRef) => {
      setup();
      const resolved = vi.fn();
      await expect(
        fetchModuleSource({ ...source, resolvedSha: sha, resolvedRef }, null, vi.fn(), resolved),
      ).rejects.toThrow('Invalid recorded ref namespace');
      expect(git).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
    },
  );
  it('refuses a moved fallback ref rather than replacing the pinned commit', async () => {
    setup();
    const previous = git.getMockImplementation()!;
    git.mockImplementation(async (cwd: string, args: string[], env: unknown) => {
      if (args.includes('fetch') && args.at(-1) === sha)
        return { code: 1, stdout: '', stderr: 'object wants not supported' };
      if (args.includes('rev-parse')) return { code: 0, stdout: 'b'.repeat(40), stderr: '' };
      return previous(cwd, args, env);
    });
    const pin = vi.fn();
    await expect(fetchModuleSource({ ...source, resolvedSha: sha }, null, pin)).rejects.toThrow(
      'module_source_ref_moved',
    );
    expect(pin).not.toHaveBeenCalled();
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
