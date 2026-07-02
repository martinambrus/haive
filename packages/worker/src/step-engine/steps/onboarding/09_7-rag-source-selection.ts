import type { FormField, FormSchema, TreeNode } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { buildFullExtensionSet, type ExtensionInfo } from './_extension-registry.js';
import { buildScopeTree } from '@haive/shared/scope-tree';
import { isDeniedPath, loadScopeExcludeGlobs } from './_scope.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RagSourceSelectionDetect {
  extensionSet: string[];
  /** The per-repo onboarding scope deny list (06_7) — directories NOT indexed. */
  scopeExclude: string[];
  inScopeFileCount: number;
  /** Top-level in-scope directory labels, for the confirmation summary. */
  inScopeTopDirs: string[];
}

export interface RagSourceSelectionApply {
  /** Retired: RAG scope is now the 06_7 deny list, applied in 10-rag-populate.
   *  Emitted empty so any legacy reader falls back to no allow-filter. */
  selectedDirs: string[];
  extensionSet: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Sum code-file counts for in-scope nodes only — a node the deny list excludes
 *  drops its whole subtree from the count. */
function sumInScopeFiles(nodes: TreeNode[], exclude: readonly string[]): number {
  let total = 0;
  for (const node of nodes) {
    if (isDeniedPath(node.path, exclude)) continue;
    total += node.fileCount ?? 0;
    if (node.children) total += sumInScopeFiles(node.children, exclude);
  }
  return total;
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
    index: 13,
    title: 'RAG source confirmation',
    description:
      "Confirms what the RAG index will cover. Scope is inherited from the onboarding scope selection (06_7) — this project's own code, minus the excluded built-in / vendored directories. Read-only; change scope on the scope-selection step or in repository settings.",
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagSourceSelectionDetect> {
    // Extension set carries over from 01_5 (drives which file types get indexed).
    await ctx.emitProgress('Loading extension data...');
    const rgPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01_5-ripgrep-config');
    const rgOutput = rgPrev?.output as { extensions?: ExtensionInfo[] } | null;
    const extensionSet = buildFullExtensionSet(rgOutput?.extensions ?? []);

    // Scope = the authoritative 06_7 deny list. Empty when 06_7 was skipped or the
    // user kept everything in scope.
    const scopeExclude = await loadScopeExcludeGlobs(ctx.db, ctx.taskId);

    await ctx.emitProgress('Scanning in-scope directories...');
    const tree = await buildScopeTree(
      ctx.repoPath,
      extensionSet.size > 0 ? { extensions: extensionSet } : {},
    );
    const inScopeFileCount = sumInScopeFiles(tree, scopeExclude);
    const inScopeTopDirs = tree
      .filter(
        (n) =>
          !isDeniedPath(n.path, scopeExclude) &&
          ((n.fileCount ?? 0) > 0 || (n.children?.length ?? 0) > 0),
      )
      .map((n) => n.label);

    await ctx.emitProgress(
      `RAG will index ~${inScopeFileCount} code file(s); ${scopeExclude.length} director(ies) excluded.`,
    );
    ctx.logger.info(
      { extensionCount: extensionSet.size, excludeCount: scopeExclude.length, inScopeFileCount },
      'rag source confirmation detect complete',
    );

    return {
      extensionSet: [...extensionSet],
      scopeExclude,
      inScopeFileCount,
      inScopeTopDirs,
    };
  },

  form(_ctx, detected): FormSchema {
    const exts = detected.extensionSet.length
      ? detected.extensionSet.slice(0, 40).join(' ')
      : '(none detected)';

    const fields: FormField[] = [
      {
        type: 'note',
        id: 'scopeSummary',
        label: 'RAG index scope',
        body:
          `The RAG index will cover approximately **${detected.inScopeFileCount}** code file(s) from ` +
          `this project's own code` +
          (detected.inScopeTopDirs.length
            ? `, across: ${detected.inScopeTopDirs.join(', ')}.`
            : '.'),
      },
    ];
    if (detected.scopeExclude.length > 0) {
      fields.push({
        type: 'note',
        id: 'scopeExcluded',
        label: 'Excluded from indexing',
        body:
          'These directories are out of scope (set on the scope-selection step) and will NOT be indexed:\n' +
          detected.scopeExclude.map((g) => `- \`${g}\``).join('\n'),
      });
    }
    fields.push({
      type: 'note',
      id: 'scopeExtensions',
      label: 'Indexed file types',
      body: `Extensions indexed into RAG: ${exts}`,
    });

    return {
      title: 'RAG source confirmation',
      description:
        'Review what the RAG index will cover. Scope is inherited from the onboarding scope selection — there is nothing to pick here.',
      fields,
      submitLabel: 'Continue to RAG indexing',
    };
  },

  async apply(ctx, args): Promise<RagSourceSelectionApply> {
    const detected = args.detected as RagSourceSelectionDetect;
    ctx.logger.info(
      { extensionCount: detected.extensionSet.length, excludeCount: detected.scopeExclude.length },
      'rag source confirmation complete',
    );
    return { selectedDirs: [], extensionSet: detected.extensionSet };
  },
};
