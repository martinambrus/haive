import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { RunRagIndexOpts } from '../src/step-engine/steps/workflow/_rag-index.js';

const resolveRagConnection = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../src/step-engine/steps/onboarding/_rag-connection.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveRagConnection,
}));

const { runRagIndexSync } = await import('../src/step-engine/steps/workflow/_rag-index.js');

const ctx = {
  db: {},
  emitProgress: async () => {},
  logger: { info: () => {}, warn: () => {} },
} as unknown as StepContext;

/** Where each scan root sits under a repository root; `elsewhere/` is a real tree beside it. */
const ROOTS: [string, (root: string) => Promise<string>, boolean][] = [
  ['the repository root', async (root) => root, true],
  [
    'a real worktree',
    async (root) => {
      await mkdir(join(root, '.haive/worktrees/wt'), { recursive: true });
      return join(root, '.haive/worktrees/wt');
    },
    true,
  ],
  [
    'a worktree that is a link',
    async (root) => {
      await mkdir(join(root, '.haive/worktrees'), { recursive: true });
      await symlink(join(root, 'elsewhere'), join(root, '.haive/worktrees/wt'));
      return join(root, '.haive/worktrees/wt');
    },
    false,
  ],
  ['a missing worktree', async (root) => join(root, '.haive/worktrees/gone'), false],
];

describe('the RAG sync refuses a scan root it cannot read as a directory', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rag-scan-root-'));
    await mkdir(join(root, 'elsewhere'));
    resolveRagConnection.mockClear();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(ROOTS)('%s', async (_name, scanRoot, syncs) => {
    const result = await runRagIndexSync(ctx, {
      repoPath: await scanRoot(root),
      prefs: {},
      projectName: 'p',
      ollamaReachable: false,
      codeCollect: {},
    } as unknown as RunRagIndexOpts);
    expect(result.performed).toBe(false);
    expect(resolveRagConnection).toHaveBeenCalledTimes(syncs ? 1 : 0);
    expect(result.reason).toMatch(syncs ? /connection resolved to null/ : /scan root was refused/);
  });
});
