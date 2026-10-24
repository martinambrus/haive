import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** `isWorktreeRegistered`, the one reader that throws on a failed `worktree list`. */
const READER = 'packages/worker/src/repo/git-workspace.ts';
/** Its `-z` list already throws on a non-zero exit, so a failed read cannot pass for "unregistered". */
const PLAN_MERGE = 'packages/worker/src/step-engine/steps/plan/01-plan-merge.ts';
const ALLOWED = [READER, PLAN_MERGE];

const WORKTREE_LIST = /(['"`])worktree\1\s*,\s*(['"`])list\2/;

async function scanRoots(): Promise<string[]> {
  const modules = await readdir(path.join(REPO, 'modules'), { withFileTypes: true });
  return [
    'packages/worker/src',
    'packages/api/src',
    'packages/shared/src',
    ...modules
      .filter((m) => m.isDirectory() && existsSync(path.join(REPO, 'modules', m.name, 'src')))
      .map((m) => `modules/${m.name}/src`),
  ];
}

async function sources(): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  for (const dir of await scanRoots()) {
    const root = path.join(REPO, dir);
    for (const rel of await readdir(root, { recursive: true })) {
      if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
      out.push({ rel: `${dir}/${rel}`, text: await readFile(path.join(root, rel), 'utf8') });
    }
  }
  return out;
}

describe('git worktree list', () => {
  it('is read in one place, so a failed list is never taken for "not registered"', async () => {
    const offenders = (await sources())
      .filter(({ rel, text }) => !ALLOWED.includes(rel) && WORKTREE_LIST.test(text))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `read the list through isWorktreeRegistered: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('still finds the argv in both allowed files, and scans the source tree', async () => {
    const all = await sources();
    expect(all.length).toBeGreaterThan(100);
    for (const rel of ALLOWED) {
      const file = all.find((s) => s.rel === rel);
      expect(file, rel).toBeDefined();
      expect(WORKTREE_LIST.test(file!.text), rel).toBe(true);
    }
  });

  it('matches a reformatted call and ignores other subcommands', () => {
    expect(WORKTREE_LIST.test("gitRun(p, ['worktree', 'list', '--porcelain'])")).toBe(true);
    expect(WORKTREE_LIST.test('["worktree",\n   "list"]')).toBe(true);
    expect(WORKTREE_LIST.test("['worktree', 'add', 'list']")).toBe(false);
  });
});
