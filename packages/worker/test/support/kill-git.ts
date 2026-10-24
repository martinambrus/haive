import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface KilledGit {
  /** Puts PATH back and removes the shim. */
  restore(): Promise<void>;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Puts a `git` first on PATH that kills itself with SIGKILL, so the run ends with no exit status
 * (`GIT_NO_EXIT`), for every call whose argv starts with `startsWith`, and runs the real git for the
 * rest. `hardenGitArgs` prepends `-c key=value` pairs, so the match skips those: `['rev-parse',
 * '--abbrev-ref', 'HEAD']` kills that read and no other `rev-parse`. `after` lets that many matching
 * calls through first, for a read that must fail the second time it is made; `contains` narrows the
 * match to calls with an argument holding that text (`show <sha>:composer.json`, not every `show`).
 */
export async function killGit(
  startsWith: string[],
  opts: { after?: number; contains?: string } = {},
): Promise<KilledGit> {
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const dir = await mkdtemp(path.join(tmpdir(), 'kill-git-'));
  const counter = path.join(dir, 'seen');
  await writeFile(counter, '');
  await writeFile(
    path.join(dir, 'git'),
    [
      '#!/bin/sh',
      'tail_args() {',
      '  while [ "$1" = "-c" ]; do shift 2; done',
      '  printf \'%s\\n\' "$@"',
      '}',
      `want=${quote(startsWith.join('\n'))}`,
      `got=$(tail_args "$@" | head -n ${startsWith.length})`,
      'match=0',
      'if [ "$got" = "$want" ]; then match=1; fi',
      ...(opts.contains ? [`case "$*" in *${quote(opts.contains)}*) ;; *) match=0 ;; esac`] : []),
      'if [ "$match" = 1 ]; then',
      `  echo x >> ${quote(counter)}`,
      `  if [ "$(wc -l < ${quote(counter)})" -gt ${opts.after ?? 0} ]; then kill -9 $$; fi`,
      'fi',
      `exec ${quote(real)} "$@"`,
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
