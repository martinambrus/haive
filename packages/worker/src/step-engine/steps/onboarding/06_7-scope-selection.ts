import type { DetectResult, FormSchema, TreeNode } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { buildFullExtensionSet, type ExtensionInfo } from './_extension-registry.js';
import { buildScopeTree } from '@haive/shared/scope-tree';
import { computeSeedExcludeGlobs } from './_scope-seed.js';
import {
  collectAllPaths,
  collectDefaults,
  collectDenyFrontier,
  readComposerJson,
  readGitignore,
  sumFileCount,
} from './_scope.js';

interface ScopeSelectionDetect {
  framework: string | null;
  tree: TreeNode[];
  /** Built-in framework dirs pre-excluded (pre-unticked) in the picker. */
  seedExcludeGlobs: string[];
  totalCodeFiles: number;
}

interface ScopeSelectionApply {
  /** Task-scoped mining deny list (the exclusion frontier). Stored ONLY in this
   *  step's output (NOT the repo) and read by the KB + skill mining steps
   *  (08/09-qa/09_5/09_5b) via loadMiningScopeExcludeGlobs. The repo-level RAG
   *  scope is chosen separately at 09_7-rag-source-selection. */
  excludeGlobs: string[];
  includedDirCount: number;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const scopeSelectionStep: StepDefinition<ScopeSelectionDetect, ScopeSelectionApply> = {
  metadata: {
    id: '06_7-scope-selection',
    workflowType: 'onboarding',
    // After 06_5-agent-discovery (index 6, stays full-repo) and before
    // 07-generate-files (7) / 08-knowledge-acquisition — so the mining scope is in
    // place before the expensive agentic mining steps read the repo.
    index: 6.5,
    title: 'Onboarding mining scope',
    description:
      'Pick which directories the onboarding mining steps (knowledge base, skills) analyse. Built-in framework code (Drupal core/contrib, vendor, ...) is pre-excluded so the expensive agentic steps only read this project’s own code. This scopes KB + skill mining for THIS onboarding run only and is not saved on the repo; the RAG index scope is chosen separately at the RAG step.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ScopeSelectionDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;

    await ctx.emitProgress('Loading extension data...');
    const rgPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01_5-ripgrep-config');
    const rgOutput = rgPrev?.output as { extensions?: ExtensionInfo[] } | null;
    const extensionSet = buildFullExtensionSet(rgOutput?.extensions ?? []);

    await ctx.emitProgress('Scanning directories...');
    const tree = await buildScopeTree(
      ctx.repoPath,
      extensionSet.size > 0 ? { extensions: extensionSet } : {},
    );

    const composer = await readComposerJson(ctx.repoPath);
    const gitignore = await readGitignore(ctx.repoPath);
    const seedExcludeGlobs = computeSeedExcludeGlobs({
      composer,
      gitignore,
      framework,
      treePaths: collectAllPaths(tree),
    });
    const totalCodeFiles = sumFileCount(tree);

    await ctx.emitProgress(
      `Found ${totalCodeFiles} code files across ${collectAllPaths(tree).length} directories.`,
    );
    ctx.logger.info(
      { framework, totalCodeFiles, seedExcludeCount: seedExcludeGlobs.length },
      'scope-selection detect complete',
    );

    return { framework, tree, seedExcludeGlobs, totalCodeFiles };
  },

  form(_ctx, detected): FormSchema {
    if (detected.tree.length === 0) {
      return {
        title: 'Onboarding mining scope',
        description: 'No directories found to scope. Mining will read the repository root only.',
        fields: [],
        submitLabel: 'Continue',
      };
    }
    const defaults = collectDefaults(detected.tree, detected.seedExcludeGlobs);
    return {
      title: 'Select the code to mine',
      description: [
        `Found ${detected.totalCodeFiles} code files.`,
        'Ticked directories are what the knowledge-base and skill mining steps analyse.',
        'Built-in framework code (Drupal core/contrib, vendor, node_modules, ...) is pre-unticked — leave it off to keep onboarding fast and focused on this project’s own code.',
        'Un-ticked directories are skipped by the mining steps for this onboarding run; new folders added by later tasks are included automatically.',
      ].join(' '),
      fields: [
        {
          type: 'directory-tree',
          id: 'selectedDirs',
          label: 'Directories to mine',
          tree: detected.tree,
          defaults,
        },
      ],
      submitLabel: 'Save scope',
    };
  },

  async apply(ctx, args): Promise<ScopeSelectionApply> {
    const detected = args.detected as ScopeSelectionDetect;
    const values = args.formValues as { selectedDirs?: string[] };
    const selected = new Set(values.selectedDirs ?? []);

    // Task-scoped: the mining deny list lives ONLY in this step's output, read by
    // the KB + skill mining steps. It is NOT written to the repo — the repo-level
    // scope_exclude_globs is the RAG scope, owned by 09_7-rag-source-selection.
    const excludeGlobs: string[] = [];
    collectDenyFrontier(detected.tree, selected, excludeGlobs);
    excludeGlobs.sort();

    ctx.logger.info(
      { excludeCount: excludeGlobs.length, selectedCount: selected.size },
      'scope-selection apply complete (task-scoped mining)',
    );
    return { excludeGlobs, includedDirCount: selected.size };
  },
};
