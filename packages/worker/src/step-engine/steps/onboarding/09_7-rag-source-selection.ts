import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  FRAMEWORK_PATTERNS,
  type DetectResult,
  type FormSchema,
  type TreeNode,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { buildFullExtensionSet, type ExtensionInfo } from './_extension-registry.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RagSourceSelectionDetect {
  framework: string;
  tree: TreeNode[];
  extensionSet: string[];
  totalCodeFiles: number;
}

export interface RagSourceSelectionApply {
  selectedDirs: string[];
  extensionSet: string[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
  '.cache',
  'coverage',
  '.tox',
  '.venv',
  'venv',
  '.claude',
  '.github',
  '.vscode',
  '.idea',
]);

const SCAN_DEPTH = 10;

/* ------------------------------------------------------------------ */
/* Recursive tree scanner                                              */
/* ------------------------------------------------------------------ */

async function buildTree(
  absDir: string,
  relDir: string,
  extensionSet: Set<string>,
  frameworkPathSet: Set<string>,
  excludePathSet: Set<string>,
  depth: number,
): Promise<TreeNode[]> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const rel = relDir ? `${relDir}/${name}` : name;
    const abs = path.join(absDir, name);

    if (IGNORE_DIRS.has(name)) continue;

    const isFrameworkPath = frameworkPathSet.has(rel);
    const isExcluded = excludePathSet.has(rel);

    // Count code files directly in this directory (not recursive)
    let fileCount = 0;
    try {
      const files = await readdir(abs, { withFileTypes: true });
      for (const f of files) {
        if (f.isDirectory()) continue;
        const ext = path.extname(f.name).toLowerCase();
        if (extensionSet.has(ext)) fileCount++;
      }
    } catch {
      /* unreadable */
    }

    // Recurse for children
    let children: TreeNode[] | undefined;
    if (depth < SCAN_DEPTH) {
      children = await buildTree(
        abs,
        rel,
        extensionSet,
        frameworkPathSet,
        excludePathSet,
        depth + 1,
      );
      if (children.length === 0) children = undefined;
    }

    const badgeColor = isFrameworkPath ? 'green' : isExcluded ? 'default' : 'amber';

    nodes.push({
      path: rel,
      label: name,
      fileCount,
      badgeColor: badgeColor as 'green' | 'amber' | 'default',
      children,
    });
  }

  nodes.sort((a, b) => a.label.localeCompare(b.label));

  return nodes;
}

/** Count root-level code files (not inside any subdirectory). */
async function countRootFiles(repoPath: string, extensionSet: Set<string>): Promise<number> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (extensionSet.has(ext)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Collect all paths from a tree recursively. */
function collectAllPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    paths.push(node.path);
    if (node.children) paths.push(...collectAllPaths(node.children));
  }
  return paths;
}

/** Sum file counts across entire tree. */
function sumFileCount(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.fileCount ?? 0;
    if (node.children) total += sumFileCount(node.children);
  }
  return total;
}

/** Collect paths that should be pre-selected (framework paths + non-excluded with files). */
function collectDefaults(
  nodes: TreeNode[],
  frameworkPathSet: Set<string>,
  excludePathSet: Set<string>,
): string[] {
  const defaults: string[] = [];
  for (const node of nodes) {
    const isFramework = frameworkPathSet.has(node.path);
    const isExcluded = excludePathSet.has(node.path);
    if ((isFramework || !isExcluded) && (node.fileCount ?? 0) > 0) {
      defaults.push(node.path);
    }
    if (node.children) {
      defaults.push(...collectDefaults(node.children, frameworkPathSet, excludePathSet));
    }
  }
  return defaults;
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
    title: 'RAG source selection',
    description:
      'Scans repository directories for code files using all detected extensions, presents a folder tree browser with checkboxes, and stores the chosen folders and extension set for RAG indexing.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagSourceSelectionDetect> {
    // Load framework from step 01
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | {
          project?: { framework?: string };
          paths?: { customCodePaths?: { include?: string[]; exclude?: string[] } };
        }
      | undefined;
    const framework = envData?.project?.framework ?? 'general';
    const patterns =
      FRAMEWORK_PATTERNS[framework as keyof typeof FRAMEWORK_PATTERNS] ??
      FRAMEWORK_PATTERNS.general;
    const customPaths = patterns.customPaths;
    const excludePaths = patterns.excludePaths;

    // Load detected extensions from step 01_5
    await ctx.emitProgress('Loading extension data...');
    const rgPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01_5-ripgrep-config');
    const rgOutput = rgPrev?.output as { extensions?: ExtensionInfo[] } | null;
    const ripgrepExtensions = rgOutput?.extensions ?? [];

    // Build full extension set
    const extensionSet = buildFullExtensionSet(ripgrepExtensions);

    // Build framework/exclude path sets (normalize trailing slashes)
    const frameworkPathSet = new Set(customPaths.map((p) => p.replace(/\/$/, '')));
    const excludePathSet = new Set(excludePaths.map((p) => p.replace(/\/$/, '')));

    // Scan directories into tree
    await ctx.emitProgress('Scanning directories for code files...');
    const tree = await buildTree(
      ctx.repoPath,
      '',
      extensionSet,
      frameworkPathSet,
      excludePathSet,
      0,
    );

    // Add root files node if there are code files at repo root
    const rootFileCount = await countRootFiles(ctx.repoPath, extensionSet);
    if (rootFileCount > 0) {
      tree.unshift({
        path: '.',
        label: '(root files)',
        fileCount: rootFileCount,
        badgeColor: 'amber',
      });
    }

    const totalCodeFiles = sumFileCount(tree);

    await ctx.emitProgress(`Found ${totalCodeFiles} code files. Select folders to index.`);

    ctx.logger.info(
      {
        framework,
        nodeCount: collectAllPaths(tree).length,
        totalCodeFiles,
        extensionCount: extensionSet.size,
      },
      'rag source selection detect complete',
    );

    return {
      framework,
      tree,
      extensionSet: [...extensionSet],
      totalCodeFiles,
    };
  },

  form(_ctx, detected): FormSchema | null {
    const totalFiles = sumFileCount(detected.tree);
    if (totalFiles === 0) {
      return {
        title: 'RAG source selection',
        description:
          'No code files found in the repository. RAG indexing will only include knowledge base files.',
        fields: [],
        submitLabel: 'Continue',
      };
    }

    // Compute defaults
    const patterns =
      FRAMEWORK_PATTERNS[detected.framework as keyof typeof FRAMEWORK_PATTERNS] ??
      FRAMEWORK_PATTERNS.general;
    const frameworkPathSet = new Set(patterns.customPaths.map((p) => p.replace(/\/$/, '')));
    const excludePathSet = new Set(patterns.excludePaths.map((p) => p.replace(/\/$/, '')));
    const defaults = collectDefaults(detected.tree, frameworkPathSet, excludePathSet);

    return {
      title: 'Select folders for RAG indexing',
      description:
        `Found ${totalFiles} code files. ` +
        `Green-badged folders are suggested by the ${detected.framework} framework pattern. ` +
        `Expand folders and tick/untick to control what gets indexed into RAG.`,
      fields: [
        {
          type: 'directory-tree',
          id: 'selectedDirs',
          label: 'Directories to index',
          tree: detected.tree,
          defaults,
        },
      ],
      submitLabel: 'Continue to RAG indexing',
    };
  },

  async apply(ctx, args): Promise<RagSourceSelectionApply> {
    const detected = args.detected as RagSourceSelectionDetect;
    const values = args.formValues as { selectedDirs?: string[] };
    const selectedDirs = values.selectedDirs ?? [];

    ctx.logger.info(
      { selectedCount: selectedDirs.length, extensionCount: detected.extensionSet.length },
      'rag source selection complete',
    );

    return {
      selectedDirs,
      extensionSet: detected.extensionSet,
    };
  },
};
