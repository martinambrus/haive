import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeGit {
  /** Puts PATH back and removes the shim. */
  restore(): Promise<void>;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Puts a `git` first on PATH that fails every call whose argv starts with `startsWith` and runs the
 * real git for the rest. `hardenGitArgs` prepends `-c key=value` pairs, so the match skips those:
 * `['remote']` fails `git remote get-url origin`, `['rev-parse', 'HEAD']` fails `rev-parse HEAD` but
 * not `rev-parse --abbrev-ref HEAD`. The failure is `exit` (default 128) with a `fatal:` line, or,
 * with `hang`, a process that outlives any shortened `gitTimeoutLimits` and is killed by it.
 * `from` and `until` (1-based, counted over the calls that match) fail only the Nth to Mth match.
 */
export async function failGit(
  startsWith: string[],
  opts: {
    exit?: number;
    hang?: boolean;
    from?: number;
    until?: number;
    afterRun?: boolean;
    stdout?: string;
  } = {},
): Promise<FakeGit> {
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-git-'));
  const counter = quote(path.join(dir, 'matches'));
  const failure = opts.hang
    ? 'exec sleep 30'
    : `printf '%s' ${quote(opts.stdout ?? '')}; echo "fatal: simulated failure" >&2; exit ${opts.exit ?? 128}`;
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
      'if [ "$got" = "$want" ]; then',
      `  seen=$(cat ${counter} 2>/dev/null || echo 0); seen=$((seen + 1)); echo "$seen" > ${counter}`,
      `  if [ "$seen" -ge ${opts.from ?? 1} ] && [ "$seen" -le ${opts.until ?? Number.MAX_SAFE_INTEGER} ]; then`,
      ...(opts.afterRun ? [`    ${quote(real)} "$@"`] : []),
      `    ${failure}`,
      '  fi',
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

/** A PATH with no git on it, so a run ends with no exit status (ENOENT). Set up fixtures first. */
export async function noGit(): Promise<FakeGit> {
  const dir = await mkdtemp(path.join(tmpdir(), 'no-git-'));
  const saved = process.env.PATH;
  process.env.PATH = dir;
  return {
    restore: async () => {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
