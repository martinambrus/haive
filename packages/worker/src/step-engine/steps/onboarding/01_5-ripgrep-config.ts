import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FrameworkName } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput } from './_helpers.js';

/* ------------------------------------------------------------------ */
/* ripgrep built-in type mappings (stable across rg 14+)              */
/* Only extensions we might encounter in web projects are listed.     */
/* ------------------------------------------------------------------ */

const RG_BUILTIN_TYPES: Record<string, Set<string>> = {
  php: new Set(['php', 'php3', 'php4', 'php5', 'phtml']),
  js: new Set(['js', 'mjs', 'cjs']),
  ts: new Set(['ts', 'tsx', 'cts', 'mts']),
  ruby: new Set(['rb', 'gemspec']),
  python: new Set(['py', 'pyi']),
  go: new Set(['go']),
  rust: new Set(['rs']),
  java: new Set(['java']),
  html: new Set(['htm', 'html', 'xhtml']),
  css: new Set(['css', 'scss', 'less']),
  json: new Set(['json', 'jsonl']),
  yaml: new Set(['yaml', 'yml']),
  xml: new Set(['xml', 'xsl', 'xslt', 'svg']),
  markdown: new Set(['md', 'markdown']),
  twig: new Set(['twig']),
};

/** Extensions that might contain PHP code even though they're not *.php */
const PHP_CANDIDATE_EXTENSIONS = new Set([
  'inc',
  'module',
  'install',
  'theme',
  'profile',
  'engine',
  'test',
]);

/** Extensions that belong to specific languages without needing content inspection */
const KNOWN_LANGUAGE_EXTENSIONS: Record<string, string> = {
  jsx: 'js',
  vue: 'js',
  svelte: 'js',
  erb: 'ruby',
  rake: 'ruby',
  blade: 'php', // blade.php handled separately
  jinja: 'html',
  jinja2: 'html',
  njk: 'html',
  hbs: 'html',
  ejs: 'html',
};

/* ------------------------------------------------------------------ */
/* Extension scanning                                                  */
/* ------------------------------------------------------------------ */

interface ExtensionInfo {
  ext: string;
  count: number;
  isPhp: boolean; // confirmed PHP via content inspection
  language: string | null; // which rg type this belongs to
}

interface RipgrepDetect {
  framework: FrameworkName;
  extensions: ExtensionInfo[];
  needsConfig: boolean;
  lines: string[];
}

async function isPhpFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buf = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buf, 0, 128, 0);
    if (bytesRead === 0) return false;
    let text = buf.subarray(0, bytesRead).toString('utf8');
    // Strip UTF-8 BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.trimStart();
    return text.startsWith('<?php') || text.startsWith('<?');
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function resolveExtension(filename: string): string | null {
  // Handle compound extensions like .blade.php
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!.toLowerCase();
  // Skip binary/media extensions
  if (
    [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'ico',
      'svg',
      'webp',
      'woff',
      'woff2',
      'ttf',
      'eot',
      'mp3',
      'mp4',
      'wav',
      'avi',
      'mov',
      'zip',
      'tar',
      'gz',
      'rar',
      '7z',
      'exe',
      'dll',
      'so',
      'dylib',
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'lock',
      'map',
    ].includes(last)
  ) {
    return null;
  }
  return last;
}

function isAlreadyCovered(ext: string): boolean {
  for (const exts of Object.values(RG_BUILTIN_TYPES)) {
    if (exts.has(ext)) return true;
  }
  return false;
}

function determineLanguageType(ext: string, isPhp: boolean): string | null {
  if (isPhp) return 'php';
  if (ext in KNOWN_LANGUAGE_EXTENSIONS) return KNOWN_LANGUAGE_EXTENSIONS[ext]!;
  return null;
}

async function scanExtensions(
  repoPath: string,
  _framework: FrameworkName,
): Promise<ExtensionInfo[]> {
  // Collect all file extensions with counts
  const extCounts = new Map<string, { count: number; samplePaths: string[] }>();

  const allFiles = await listFilesMatching(
    repoPath,
    (rel, isDir) => {
      if (isDir) return false;
      const ext = resolveExtension(rel);
      return ext !== null && !isAlreadyCovered(ext);
    },
    5,
  );

  for (const rel of allFiles) {
    const ext = resolveExtension(rel);
    if (!ext) continue;
    const entry = extCounts.get(ext) ?? { count: 0, samplePaths: [] };
    entry.count += 1;
    if (entry.samplePaths.length < 3) {
      entry.samplePaths.push(path.join(repoPath, rel));
    }
    extCounts.set(ext, entry);
  }

  // For PHP-candidate extensions, inspect file content
  const results: ExtensionInfo[] = [];

  for (const [ext, { count, samplePaths }] of extCounts) {
    let isPhp = false;
    if (PHP_CANDIDATE_EXTENSIONS.has(ext)) {
      // Check up to 3 sample files for <?php
      for (const sample of samplePaths) {
        if (await isPhpFile(sample)) {
          isPhp = true;
          break;
        }
      }
    }
    const language = determineLanguageType(ext, isPhp);
    if (language) {
      results.push({ ext, count, isPhp, language });
    }
  }

  return results.sort((a, b) => b.count - a.count);
}

function buildRipgreprcLines(extensions: ExtensionInfo[], framework: FrameworkName): string[] {
  if (extensions.length === 0) return [];

  const lines: string[] = [
    `# Ripgrep configuration for ${framework} project`,
    '# Auto-generated by haive env-detect based on actual file extension scan',
    '',
  ];

  // Group by language type
  const byLanguage = new Map<string, string[]>();
  for (const { ext, language } of extensions) {
    if (!language) continue;
    const list = byLanguage.get(language) ?? [];
    list.push(ext);
    byLanguage.set(language, list);
  }

  for (const [language, exts] of byLanguage) {
    lines.push(`# Extend ${language} type with project-specific extensions`);
    for (const ext of exts) {
      lines.push(`--type-add=${language}:*.${ext}`);
    }
    lines.push('');
  }

  lines.push('--smart-case');
  lines.push('');
  return lines;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

interface EnvDetectShape {
  data: { project: { framework: FrameworkName } };
}

export const ripgrepConfigStep: StepDefinition<
  RipgrepDetect,
  { configWritten: boolean; path: string | null; extensions: ExtensionInfo[] }
> = {
  metadata: {
    id: '01_5-ripgrep-config',
    workflowType: 'onboarding',
    index: 2,
    title: 'Ripgrep configuration',
    description:
      'Scans repository for file extensions not covered by ripgrep built-in types, validates PHP-like files by content inspection, and generates a project .ripgreprc when needed.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RipgrepDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const detected = (prev?.detect as DetectResult | null)?.data as
      | EnvDetectShape['data']
      | undefined;
    const framework = (detected?.project?.framework ?? 'general') as FrameworkName;

    const extensions = await scanExtensions(ctx.repoPath, framework);
    const lines = buildRipgreprcLines(extensions, framework);

    ctx.logger.info(
      {
        framework,
        extensionsFound: extensions.length,
        phpConfirmed: extensions.filter((e) => e.isPhp).length,
        needsConfig: lines.length > 0,
      },
      'ripgrep extension scan complete',
    );

    return {
      framework,
      extensions,
      needsConfig: lines.length > 0,
      lines,
    };
  },

  async apply(ctx, args) {
    const detected = args.detected;
    if (!detected.needsConfig || detected.lines.length === 0) {
      ctx.logger.info({ framework: detected.framework }, 'no ripgrep config needed');
      return { configWritten: false, path: null, extensions: detected.extensions };
    }
    const target = path.join(ctx.repoPath, '.ripgreprc');
    await writeFile(target, detected.lines.join('\n'), 'utf8');
    ctx.logger.info(
      {
        target,
        framework: detected.framework,
        extensionCount: detected.extensions.length,
      },
      'wrote .ripgreprc from extension scan',
    );
    return { configWritten: true, path: '.ripgreprc', extensions: detected.extensions };
  },
};
