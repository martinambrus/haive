import { FRAMEWORK_PATTERNS } from '@haive/shared';
import { schema } from '@haive/database';
import { eq } from 'drizzle-orm';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { detectFrameworkMatch } from '../../../repo/framework-detect.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepDefinition } from '../../step-definition.js';
import {
  detectRagSourceSelection,
  ragSourceSelectionStep,
  type RagSourceSelectionDetect,
  type RagSourceSelectionApply,
} from '../onboarding/09_7-rag-source-selection.js';
import { CODE_EXTENSIONS } from '../onboarding/_rag-chunkers.js';
import { resolveRagSyncPrefs } from './_rag-index.js';
import { resolveRagWorkspace } from './11c-rag-reindex.js';

/** No onboarding detector has run on a blank repo. Probe the existing framework
 * markers without walking dependency trees, then use the usual scoring rule.
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
      'Choose which parts of this new project to index into RAG. Framework, library, generated, and agent tooling folders are pre-excluded. The scope is saved for future tasks.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const resolved = await resolveRagSyncPrefs(ctx, true);
    if (!resolved.ragConfigured || !resolved.needsScopeSelection) return false;
    if (!resolved.needsInitialization) return true;
    // Quick fixes have no 11c initialization step. Existing RAG still gets the
    // picker here, so its next pre-sync can resume, but an unconfigured quick fix
    // does not ask for a scope until a workflow can offer ingestion.
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { executionPath: true },
    });
    return task?.executionPath !== 'quick_bugfix';
  },

  async detect(ctx) {
    const repoPath = await resolveRagWorkspace(ctx);
    const workspace = workspaceAnchor(repoPath);
    const match = await probeFramework(workspace);
    return detectRagSourceSelection(ctx, {
      workspace,
      framework: match.framework,
      frameworkBase: match.base,
      // Workflow sync has no 09_7 output to restrict extensions. Count exactly
      // the collector's default set so the picker and ingestion cover the same files.
      extensionSet: Object.keys(CODE_EXTENSIONS),
    });
  },

  form: (ctx, detected) => ragSourceSelectionStep.form!(ctx, detected),
  apply: (ctx, args) => ragSourceSelectionStep.apply(ctx, args),
};
