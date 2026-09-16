import path from 'node:path';
import { DEFAULT_EXCLUDED_PATTERNS, FRAMEWORK_PATTERNS, type FrameworkName } from '@haive/shared';
import { lstatNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';

export interface DetectionResult {
  framework: FrameworkName | null;
  languages: Record<string, number>;
  fileTree: string[];
  sizeBytes: number;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'LESS',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.turbo',
  'dist',
  'build',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
]);

export async function detectFromDirectory(rootDir: string): Promise<DetectionResult> {
  const fileTree = await buildFileTree(rootDir);
  const framework = detectFramework(fileTree);
  const languages = detectLanguages(fileTree);
  const sizeBytes = await calculateSize(rootDir);
  return { framework, languages, fileTree, sizeBytes };
}

/** Every non-excluded file under `root`, as repository-relative paths.
 *
 *  Walked with `readdirNoFollow`, so a linked directory is never descended and a linked entry is
 *  never listed: this tree is what `01-env-detect` picks database-config samples from and what the
 *  detection prompt renders, and a repository is not trusted input. A `Dirent` answers the kind
 *  without following anything, so only real directories recurse and only real files are listed —
 *  links, FIFOs and sockets, which the old `else` branch reported as files, are all skipped. */
export async function buildFileTree(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdirNoFollow(root, prefix);
  if (entries === null) return files;

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.ddev') continue;

    if (entry.isDirectory()) {
      const subFiles = await buildFileTree(root, relPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const isExcluded = DEFAULT_EXCLUDED_PATTERNS.some((pattern) => {
        if (pattern.startsWith('*.')) return ext === pattern.slice(1);
        return entry.name === pattern;
      });
      if (!isExcluded) files.push(relPath);
    }
  }

  return files.sort();
}

export function detectFramework(fileTree: string[]): FrameworkName | null {
  let bestMatch: FrameworkName | null = null;
  let bestScore = 0;
  let bestRatio = 0;

  for (const [framework, config] of Object.entries(FRAMEWORK_PATTERNS) as [
    FrameworkName,
    (typeof FRAMEWORK_PATTERNS)[FrameworkName],
  ][]) {
    if (framework === 'general') continue;

    const score = config.indicators.reduce((acc: number, indicator: string) => {
      const matches = fileTree.some(
        (f) => f.startsWith(indicator) || f === indicator.replace(/\/$/, ''),
      );
      return acc + (matches ? 1 : 0);
    }, 0);

    // A tie goes to the pattern that matched most COMPLETELY, because the patterns
    // that tie are a general/specific pair and the specific one is the answer.
    // MEASURED on a live Drupal 7 repo: `drupal` matches 3 of its 4 indicators
    // (`modules/`, `themes/`, `sites/` — D7 has all three, only `core/` is D8+) and
    // `drupal7` matches 3 of 3, so comparing the raw score alone kept whichever came
    // first in FRAMEWORK_PATTERNS and reported that site as `drupal`. Ratio never
    // overrides a higher score: a real D8 site matches all four and drops `drupal7`
    // to zero, since it has no `sites/all/` and no root `includes/bootstrap.inc`.
    const ratio = score / config.indicators.length;
    if (score > bestScore || (score === bestScore && ratio > bestRatio)) {
      bestScore = score;
      bestRatio = ratio;
      bestMatch = framework;
    }
  }

  return bestScore >= 2 ? bestMatch : null;
}

export function detectLanguages(fileTree: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of fileTree) {
    const ext = path.extname(file).toLowerCase();
    const language = EXT_TO_LANGUAGE[ext];
    if (language) {
      counts[language] = (counts[language] ?? 0) + 1;
    }
  }
  return counts;
}

/** Bytes under `root`, excluding the usual generated trees.
 *
 *  Walks with the same no-follow listing as `buildFileTree` and sizes each entry with `lstat`, so a
 *  linked directory is not descended (which would have counted an outside tree, or the repository
 *  twice through a self-referential link) and a link is counted as the few bytes it is. */
async function calculateSize(root: string, rel = ''): Promise<number> {
  let total = 0;
  const entries = await readdirNoFollow(root, rel);
  if (entries === null) return 0;
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      total += await calculateSize(root, childRel);
    } else {
      const info = await lstatNoFollow(root, childRel);
      if (info !== null) total += info.stats.size;
    }
  }
  return total;
}
