import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { hardenGitArgs } from '../src/git-args.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it.each(['fetch', 'push'])('refuses a local origin %s at the protocol layer', (command) => {
  const base = mkdtempSync(path.join(tmpdir(), 't388-protocol-'));
  dirs.push(base);
  const git = (args: string[], cwd = base) =>
    execFileSync('git', hardenGitArgs(args), {
      cwd,
      encoding: 'utf8',
    });
  git(['init', '--bare', `${base}/bare`]);
  git(['init', '-b', 'main', `${base}/work`]);
  const work = `${base}/work`;
  git(
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ],
    work,
  );
  git(['-c', 'protocol.file.allow=always', 'push', `${base}/bare`, 'main'], work);
  git(['remote', 'add', 'origin', `${base}/bare`], work);
  const result = spawnSync('git', hardenGitArgs([command, 'origin', 'main']), {
    cwd: work,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).not.toBe(0);
  // The default production hardening refuses the host path too.
  expect(() => git(['fetch', '--', `${base}/bare`, 'main'], work)).toThrow();
  // Refresh opts in at its call site; exercise that hardening path explicitly.
  expect(() =>
    execFileSync(
      'git',
      hardenGitArgs(['fetch', '--', `${base}/bare`, 'main'], { allowFileTransport: true }),
      { cwd: work },
    ),
  ).not.toThrow();
});
