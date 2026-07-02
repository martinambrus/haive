import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, FormSchema, TreeNode } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { buildFullExtensionSet, type ExtensionInfo } from './_extension-registry.js';
import { buildScopeTree } from '@haive/shared/scope-tree';
import { computeSeedExcludeGlobs } from './_scope-seed.js';

interface ScopeSelectionDetect {
  framework: string | null;
  tree: TreeNode[];
  /** Built-in framework dirs pre-excluded (pre-unticked) in the picker. */
  seedExcludeGlobs: string[];
  totalCodeFiles: number;
}

interface ScopeSelectionApply {
  /** Persisted deny list (the exclusion frontier) written to
   *  repositories.scope_exclude_globs. */
  excludeGlobs: string[];
  includedDirCount: number;
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function collectAllPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.path);
    if (node.children) out.push(...collectAllPaths(node.children));
  }
  return out;
}

function sumFileCount(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.fileCount ?? 0;
    if (node.children) total += sumFileCount(node.children);
  }
  return total;
}

/** A path is covered by the seed when it IS a seed glob or sits UNDER one, so the
 *  whole excluded subtree starts unticked. */
function isCoveredBySeed(p: string, seed: readonly string[]): boolean {
  for (const s of seed) {
    if (p === s || p.startsWith(`${s}/`)) return true;
  }
  return false;
}

/** Default selection = every tree dir NOT covered by the seed. The picker checkbox
 *  treats a parent as fully-checked only when all descendants are in the value set,
 *  so defaults must list every included node explicitly. */
function collectDefaults(tree: TreeNode[], seed: readonly string[]): string[] {
  return collectAllPaths(tree).filter((p) => !isCoveredBySeed(p, seed));
}

/** The exclusion frontier: the shallowest un-selected dirs. Descend ONLY into
 *  selected nodes, so the first un-selected node on each path is recorded and its
 *  whole subtree is excluded by that single entry. Mirrors the directory-tree
 *  component invariant (a selected — even indeterminate — node keeps its own path
 *  in the value set; an un-selected node's path is absent).
 *
 *  v1 limitation: excluding a dir excludes its entire subtree; re-including a
 *  descendant of an excluded dir is not representable here — untick at the leaf. */
function collectDenyFrontier(tree: TreeNode[], selected: Set<string>, out: string[]): void {
  for (const node of tree) {
    if (selected.has(node.path)) {
      if (node.children) collectDenyFrontier(node.children, selected, out);
    } else {
      out.push(node.path);
    }
  }
}

async function resolveRepositoryId(ctx: StepContext): Promise<string | null> {
  const rows = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  return rows[0]?.repositoryId ?? null;
}

async function readComposerJson(repoPath: string): Promise<unknown> {
  try {
    const text = await readFile(path.join(repoPath, 'composer.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readGitignore(repoPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoPath, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const scopeSelectionStep: StepDefinition<ScopeSelectionDetect, ScopeSelectionApply> = {
  metadata: {
    id: '06_7-scope-selection',
    workflowType: 'onboarding',
    // After 06_5-agent-discovery (index 6, stays full-repo) and before
    // 07-generate-files (7) / 08-knowledge-acquisition — so the deny list is in
    // place before the expensive agentic mining steps read the repo.
    index: 6.5,
    title: 'Onboarding scope selection',
    description:
      'Pick which directories the onboarding mining steps (knowledge base, skills) and RAG index. Built-in framework code (Drupal core/contrib, vendor, ...) is pre-excluded so the expensive agentic steps only read this project’s own code. Un-ticked directories are stored as the per-repo scope exclusion list.',
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
        title: 'Onboarding scope',
        description:
          'No directories found to scope. Onboarding will read the repository root only.',
        fields: [],
        submitLabel: 'Continue',
      };
    }
    const defaults = collectDefaults(detected.tree, detected.seedExcludeGlobs);
    return {
      title: 'Select the code to mine',
      description: [
        `Found ${detected.totalCodeFiles} code files.`,
        'Ticked directories are read by the knowledge-base and skill mining steps and indexed into RAG.',
        'Built-in framework code (Drupal core/contrib, vendor, node_modules, ...) is pre-unticked — leave it off to keep onboarding fast and focused on this project’s own code.',
        'Un-ticked directories become the per-repo scope exclusion list; new folders added by later tasks are included automatically.',
      ].join(' '),
      fields: [
        {
          type: 'directory-tree',
          id: 'selectedDirs',
          label: 'Directories to mine + index',
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

    const excludeGlobs: string[] = [];
    collectDenyFrontier(detected.tree, selected, excludeGlobs);
    excludeGlobs.sort();

    const repositoryId = await resolveRepositoryId(ctx);
    if (repositoryId) {
      await ctx.db
        .update(schema.repositories)
        .set({ scopeExcludeGlobs: excludeGlobs, updatedAt: new Date() })
        .where(eq(schema.repositories.id, repositoryId));
    } else {
      ctx.logger.warn('scope-selection: no repositoryId for task, deny list not persisted');
    }

    ctx.logger.info(
      { excludeCount: excludeGlobs.length, selectedCount: selected.size },
      'scope-selection apply complete',
    );
    return { excludeGlobs, includedDirCount: selected.size };
  },
};
