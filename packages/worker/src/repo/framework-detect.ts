import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { DEFAULT_EXCLUDED_PATTERNS, FRAMEWORK_PATTERNS, type FrameworkName } from '@haive/shared';

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

export async function buildFileTree(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.ddev') continue;

    if (entry.isDirectory()) {
      const subFiles = await buildFileTree(path.join(dir, entry.name), relPath);
      files.push(...subFiles);
    } else {
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

    if (score > bestScore) {
      bestScore = score;
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

async function calculateSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await calculateSize(fullPath);
    } else {
      try {
        const s = await stat(fullPath);
        total += s.size;
      } catch {
        // ignore unreadable files
      }
    }
  }
  return total;
}
