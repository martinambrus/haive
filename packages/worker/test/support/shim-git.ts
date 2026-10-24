import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ShimGit {
  /** Puts PATH back and removes the shim. */
  restore(): Promise<void>;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Puts a `git` first on PATH that runs `scriptBody` as an sh script. `$REAL_GIT` is the real git and
 * `$SUB` the first argument after the `-c k=v` pairs `hardenGitArgs` prepends; the body ends with
 * `exec "$REAL_GIT" "$@"` to answer a call for real. Set up fixtures first.
 */
export async function shimGit(scriptBody: string): Promise<ShimGit> {
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const dir = await mkdtemp(path.join(tmpdir(), 'shim-git-'));
  await writeFile(
    path.join(dir, 'git'),
    [
      '#!/bin/sh',
      `REAL_GIT=${quote(real)}`,
      'SUB=',
      'for a in "$@"; do',
      '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
      '  if [ "$a" = "-c" ]; then skip=1; continue; fi',
      '  SUB=$a; break',
      'done',
      scriptBody,
      '',
    ].join('\n'),
  );
  await chmod(path.join(dir, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  return {
    restore: async () => {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
