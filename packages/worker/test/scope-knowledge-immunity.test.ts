import { describe, expect, it } from 'vitest';
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
  };
}

/** Only `src` stays ticked — the user unticked vendor AND the whole
 *  `.haive-data` subtree, which is what cascades a deny glob onto knowledge. */
const SELECTED = ['src'];

describe('06_7-scope-selection apply', () => {
  it('denies the unticked dirs but never the knowledge dirs', async () => {
    const out = (await scopeSelectionStep.apply(fakeCtx(), {
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
