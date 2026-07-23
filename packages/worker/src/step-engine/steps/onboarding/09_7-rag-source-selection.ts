import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
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
  loadRepoScopeExcludeGlobs,
  readComposerJson,
  readGitignore,
  resolveRepositoryId,
  sumFileCount,
} from './_scope.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RagSourceSelectionDetect {
  framework: string | null;
  tree: TreeNode[];
  /** Directories pre-unticked in the picker (the default RAG deny list). */
  defaultExcludeGlobs: string[];
  extensionSet: string[];
  totalCodeFiles: number;
}

export interface RagSourceSelectionApply {
  /** The RAG deny list (exclusion frontier) persisted to
   *  repositories.scope_exclude_globs — the repo-level global RAG scope. */
  excludeGlobs: string[];
  includedDirCount: number;
  extensionSet: string[];
  /** Legacy allow-list, retired — emitted empty so 10-rag-populate's optional
   *  dir-filter stays inert (RAG scope is the deny list now). */
  selectedDirs: string[];
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const ragSourceSelectionStep: StepDefinition<
  RagSourceSelectionDetect,
  RagSourceSelectionApply
> = {
  metadata: {
    id: '09_7-rag-source-selection',
    workflowType: 'onboarding',
    // Right before 10-rag-populate (14): choose what RAG indexes for this repo.
    index: 13,
    title: 'RAG index scope',
    description:
      "Pick which directories are indexed into RAG (cross-task semantic search) for this repository. Built-in framework code (Drupal core/contrib, vendor, ...) is pre-excluded so the index stays focused on this project's own code. This is the repo-level global RAG scope — saved on the repository, reused by every task, and editable later in repository settings. It defaults to your onboarding mining selection.",
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagSourceSelectionDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      { project?: { framework?: string } } | undefined;
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

    // Default the RAG deny list to (in order): the repo's stored RAG scope
    // (re-onboard / repo-settings memory), else THIS run's mining pick (06_7),
    // else the deterministic framework seed. `null` from the raw repo read means
    // "never set" (fall through); `[]` means "index everything" (respected).
    const repoRaw = await loadRepoScopeExcludeGlobs(ctx.db, ctx.taskId);
    const miningPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06_7-scope-selection');
    const miningExclude = (miningPrev?.output as { excludeGlobs?: string[] } | null)?.excludeGlobs;
    const composer = await readComposerJson(ctx.repoPath);
    const gitignore = await readGitignore(ctx.repoPath);
    const seedExclude = computeSeedExcludeGlobs({
      composer,
      gitignore,
      framework,
      treePaths: collectAllPaths(tree),
    });
    const defaultExcludeGlobs =
      repoRaw ?? (Array.isArray(miningExclude) ? miningExclude : seedExclude);

    const totalCodeFiles = sumFileCount(tree);
    await ctx.emitProgress(
      `Found ${totalCodeFiles} code files across ${collectAllPaths(tree).length} directories.`,
    );
    ctx.logger.info(
      { framework, totalCodeFiles, defaultExcludeCount: defaultExcludeGlobs.length },
      'rag-source-selection detect complete',
    );

    return {
      framework,
      tree,
      defaultExcludeGlobs,
      extensionSet: [...extensionSet],
      totalCodeFiles,
    };
  },

  form(_ctx, detected): FormSchema {
    if (detected.tree.length === 0) {
      return {
        title: 'RAG index scope',
        description: 'No directories found to scope. RAG will index the repository root only.',
        fields: [],
        submitLabel: 'Continue to RAG indexing',
      };
    }
    const defaults = collectDefaults(detected.tree, detected.defaultExcludeGlobs);
    return {
      title: 'Select the code to index into RAG',
      description: [
        `Found ${detected.totalCodeFiles} code files.`,
        'Ticked directories are indexed into the RAG semantic-search index reused across every task.',
        'Built-in framework code (Drupal core/contrib, vendor, node_modules, ...) is pre-unticked — leave it off to keep the RAG index focused on this project’s own code.',
        'This is the repository’s global RAG scope: it is saved on the repo (editable later in repository settings). It defaults to your onboarding mining selection — adjust it if RAG should cover more or less.',
        'Un-ticked directories become the repo RAG exclusion list; new folders added by later tasks are included automatically.',
      ].join(' '),
      fields: [
        {
          type: 'directory-tree',
          id: 'selectedDirs',
          label: 'Directories to index into RAG',
          tree: detected.tree,
          defaults,
        },
      ],
      submitLabel: 'Save RAG scope',
    };
  },

  async apply(ctx, args): Promise<RagSourceSelectionApply> {
    const detected = args.detected as RagSourceSelectionDetect;
    const values = args.formValues as { selectedDirs?: string[] };
    const selected = new Set(values.selectedDirs ?? []);

    const excludeGlobs: string[] = [];
    collectDenyFrontier(detected.tree, selected, excludeGlobs);
    excludeGlobs.sort();

    const repositoryId = await resolveRepositoryId(ctx.db, ctx.taskId);
    if (repositoryId) {
      await ctx.db
        .update(schema.repositories)
        .set({ scopeExcludeGlobs: excludeGlobs, updatedAt: new Date() })
        .where(eq(schema.repositories.id, repositoryId));
    } else {
      ctx.logger.warn(
        'rag-source-selection: no repositoryId for task, RAG deny list not persisted',
      );
    }

    ctx.logger.info(
      { excludeCount: excludeGlobs.length, selectedCount: selected.size },
      'rag-source-selection apply complete',
    );
    return {
      excludeGlobs,
      includedDirCount: selected.size,
      extensionSet: detected.extensionSet,
      selectedDirs: [],
    };
  },
};
