import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import type { TreeNode } from '@haive/shared';
import { KB_DIR, LEARNINGS_DIR, MANAGED_KNOWLEDGE_BADGE } from '@haive/shared/knowledge-paths';
import { REPO_ROOT_NODE_PATH } from '@haive/shared/scope-tree';
import { scopeSelectionStep } from '../src/step-engine/steps/onboarding/06_7-scope-selection.js';
import { ragSourceSelectionStep } from '../src/step-engine/steps/onboarding/09_7-rag-source-selection.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

/** The picker tree as buildScopeTree produces it once `.haive-data/` exists on
 *  disk: a transparent repo-root container over the real sub-dirs. */
const TREE: TreeNode[] = [
  {
    path: REPO_ROOT_NODE_PATH,
    label: 'Repository root',
    kind: 'repo-root',
    children: [
      { path: 'src', label: 'src', fileCount: 12 },
      { path: 'vendor', label: 'vendor', fileCount: 900 },
      {
        path: '.haive-data',
        label: '.haive-data',
        children: [
          { path: KB_DIR, label: 'knowledge_base', badge: MANAGED_KNOWLEDGE_BADGE },
          { path: LEARNINGS_DIR, label: 'learnings', badge: MANAGED_KNOWLEDGE_BADGE },
        ],
      },
    ],
  },
];

function fakeCtx(): StepContext {
  return {
    taskId: 'task-1',
    taskStepId: 'step-1',
    userId: 'user-1',
    repoPath: '/tmp/does-not-matter',
    workspacePath: '/tmp/does-not-matter',
    cliProviderId: null,
    db: undefined as never,
    logger: logger.child({ test: 'scope-knowledge-immunity' }),
    emitProgress: async () => {},
    sandboxWorkdir: '/haive/workdir',
    round: 0,
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
  };
}

/** Only `src` stays ticked — the user unticked vendor AND the whole
 *  `.haive-data` subtree, which is what cascades a deny glob onto knowledge. */
const SELECTED = ['src'];

describe('06_7-scope-selection apply', () => {
  it('denies the unticked dirs but never the knowledge dirs', async () => {
    const out = (await scopeSelectionStep.apply(fakeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected: { framework: null, tree: TREE, seedExcludeGlobs: [], totalCodeFiles: 912 },
      formValues: { selectedDirs: SELECTED },
    })) as { excludeGlobs: string[] };

    expect(out.excludeGlobs).toContain('vendor');
    expect(out.excludeGlobs).not.toContain('.haive-data');
    expect(out.excludeGlobs).not.toContain(KB_DIR);
    expect(out.excludeGlobs).not.toContain(LEARNINGS_DIR);
  });
});

describe('09_7-rag-source-selection apply', () => {
  it('drops a .haive-data untick from the repo-level RAG deny list', async () => {
    const out = (await ragSourceSelectionStep.apply(fakeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected: {
        framework: null,
        tree: TREE,
        defaultExcludeGlobs: [],
        extensionSet: ['.ts'],
        totalCodeFiles: 912,
      },
      formValues: { selectedDirs: SELECTED },
    })) as { excludeGlobs: string[] };

    expect(out.excludeGlobs).toEqual(['vendor']);
  });
});

describe('09_7-rag-source-selection apply and the project state record', () => {
  const USER = '00000000-0000-4000-8000-0000000000a1';
  const TASK = '00000000-0000-4000-8000-0000000000c1';
  const REPO = '00000000-0000-4000-8000-0000000000b1';
  const OTHER = '00000000-0000-4000-8000-0000000000b2';

  it('stores the deny list and marks the record of that repository dirty', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
    for (const id of [REPO, OTHER]) {
      fake.insert(schema.repositories, { id, userId: USER, name: id, source: 'blank' });
    }
    fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });

    await ragSourceSelectionStep.apply({ ...fakeCtx(), db: fake.db, taskId: TASK } as never, {
      iteration: 0,
      previousIterations: [],
      detected: {
        framework: null,
        tree: TREE,
        defaultExcludeGlobs: [],
        extensionSet: ['.ts'],
        totalCodeFiles: 912,
      },
      formValues: { selectedDirs: SELECTED },
    });

    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.scopeExcludeGlobs).toEqual([
      'vendor',
    ]);
    expect(fake.rows(schema.projectStateOutbox)).toEqual([
      expect.objectContaining({ repositoryId: REPO, revision: 1, writtenRevision: 0 }),
    ]);
  });
});
