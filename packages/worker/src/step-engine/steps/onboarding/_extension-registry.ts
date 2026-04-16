/**
 * Shared extension/language mappings used by ripgrep config (01_5)
 * and RAG source selection (09_7).
 */

/* ------------------------------------------------------------------ */
/* ripgrep built-in type mappings (stable across rg 14+)              */
/* ------------------------------------------------------------------ */

export const RG_BUILTIN_TYPES: Record<string, Set<string>> = {
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

/** Extensions that belong to specific languages without needing content inspection */
export const KNOWN_LANGUAGE_EXTENSIONS: Record<string, string> = {
  jsx: 'js',
  vue: 'js',
  svelte: 'js',
  erb: 'ruby',
  rake: 'ruby',
  blade: 'php',
  jinja: 'html',
  jinja2: 'html',
  njk: 'html',
  hbs: 'html',
  ejs: 'html',
};

/** RG type names that represent actual code (not markup/config/docs) */
const CODE_RELEVANT_RG_TYPES = new Set(['php', 'js', 'ts', 'ruby', 'python', 'go', 'rust', 'java']);

/** Code-relevant language extensions from KNOWN_LANGUAGE_EXTENSIONS */
const CODE_RELEVANT_KNOWN = new Set(['jsx', 'vue', 'svelte', 'erb', 'rake', 'blade']);

export interface ExtensionInfo {
  ext: string;
  language: string | null;
}

/**
 * Build the full set of code-relevant file extensions (dotted, e.g. '.js')
 * by merging RG built-in types, known language extensions, and
 * project-specific extensions detected by the ripgrep config step.
 */
export function buildFullExtensionSet(
  ripgrepExtensions: readonly ExtensionInfo[] = [],
): Set<string> {
  const result = new Set<string>();

  // 1. Code-relevant extensions from RG_BUILTIN_TYPES
  for (const [typeName, exts] of Object.entries(RG_BUILTIN_TYPES)) {
    if (CODE_RELEVANT_RG_TYPES.has(typeName)) {
      for (const ext of exts) result.add(`.${ext}`);
    }
  }

  // 2. Code-relevant extensions from KNOWN_LANGUAGE_EXTENSIONS
  for (const ext of Object.keys(KNOWN_LANGUAGE_EXTENSIONS)) {
    if (CODE_RELEVANT_KNOWN.has(ext)) result.add(`.${ext}`);
  }

  // 3. Project-specific extensions detected by ripgrep step (only those with a language)
  for (const info of ripgrepExtensions) {
    if (info.language) result.add(`.${info.ext}`);
  }

  return result;
}
