import { FRAMEWORK_PATTERNS } from '@haive/shared';
import { schema } from '@haive/database';
import { eq } from 'drizzle-orm';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { detectFrameworkMatch } from '../../../repo/framework-detect.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  detectRagSourceSelection,
  ragSourceSelectionStep,
  type RagSourceSelectionDetect,
  type RagSourceSelectionApply,
} from '../onboarding/09_7-rag-source-selection.js';
import { CODE_EXTENSIONS } from '../onboarding/_rag-chunkers.js';
import { resolveRagSyncPrefs } from './_rag-index.js';
import { resolveRagWorkspace } from './11c-rag-reindex.js';

/** Probe framework markers in the current checkout without walking dependency
 * trees, rather than relying on an old onboarding detector.
 * Composer installer paths and .gitignore cover custom docroots in the shared picker. */
async function probeFramework(wa: { anchor: string; prefix: string }): Promise<{
  framework: string | null;
  base: string;
}> {
  const indicators = [
    ...new Set(Object.values(FRAMEWORK_PATTERNS).flatMap((p) => [...p.indicators])),
  ];
  // Compare both roots: theme tooling at the root must not hide Drupal in web/,
  // and a frontend in web/ must not hide a stronger backend match at the root.
  const candidates = await Promise.all(
    ['', 'web/'].map(async (base) => {
      const present = await Promise.all(
        indicators.map(async (indicator) => {
          const rel = `${wa.prefix}${base}${indicator.replace(/\/$/, '')}`;
          const info = await lstatNoFollow(wa.anchor, rel);
          const expectedKind = indicator.endsWith('/') ? 'directory' : 'file';
          return info?.kind === expectedKind ? indicator : null;
        }),
      );
      const match = detectFrameworkMatch(present.filter((p) => p !== null));
      return match ? { ...match, base } : null;
    }),
  );
  const best = candidates
    .filter((candidate) => candidate !== null)
    .sort((a, b) => b.score - a.score || b.ratio - a.ratio)[0];
  return { framework: best?.framework ?? null, base: best?.base ?? '' };
}

/** The picker and ingestion use the same checkout and extension selection. */
export async function detectWorkflowRagSourceSelection(ctx: StepContext, repoPath: string) {
  const workspace = workspaceAnchor(repoPath);
  const match = await probeFramework(workspace);
  const resolved = await resolveRagSyncPrefs(ctx);
  return detectRagSourceSelection(ctx, {
    workspace,
    framework: match.framework,
    frameworkBase: match.base,
    extensionSet: resolved.codeCollect.extensionSet ?? Object.keys(CODE_EXTENSIONS),
  });
}

export const workflowRagSourceSelectionStep: StepDefinition<
  RagSourceSelectionDetect,
  RagSourceSelectionApply
> = {
  metadata: {
    id: '11b1-rag-source-selection',
    workflowType: 'workflow',
    index: 11.6,
    title: 'Select RAG index scope',
    description:
      'Review the current project folders before RAG re-indexing. Saved exclusions are preselected, and the updated scope is saved for future tasks.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const resolved = await resolveRagSyncPrefs(ctx, true);
    if (!resolved.ragConfigured) return false;
    // Quick fixes ingest only at 02, whose own picker runs before that sync.
    // Keep this step registered in the spine for tasks already parked here.
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { executionPath: true },
    });
    return task?.executionPath !== 'quick_bugfix';
  },

  async detect(ctx) {
    const repoPath = await resolveRagWorkspace(ctx);
    return detectWorkflowRagSourceSelection(ctx, repoPath);
  },

  form: (ctx, detected) => ragSourceSelectionStep.form!(ctx, detected),
  apply: (ctx, args) => ragSourceSelectionStep.apply(ctx, args),
};
