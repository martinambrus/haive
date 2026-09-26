import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RTK_SETTINGS_FILES } from '../src/templates/rtk-settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCAN_ROOTS = ['packages/api/src', 'packages/worker/src', 'packages/shared/src'];
const TABLE_FILE = 'packages/shared/src/templates/rtk-settings.ts';
const PATHS = new Set<string>(RTK_SETTINGS_FILES.map((file) => file.diskPath));

/** 1-based lines of the string literals in `text` that name a settings path whole. */
function literalLines(text: string, tsx = false): number[] {
  const kind = tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.ES2024, true, kind);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      PATHS.has(node.text)
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...sourceFiles(full));
    } else if (
      /\.(?:[mc]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|d)\.(?:[mc]?ts|tsx)$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('RTK settings paths', () => {
  it('finds a literal naming one, and nothing in a comment or a longer path', () => {
    const source = [
      "const a = '.claude/settings.json';",
      "// '.gemini/settings.json'",
      'const b = `${home}/.gemini/settings.json`;',
      'const c = `.gemini/settings.json`;',
    ].join('\n');
    expect(literalLines(source)).toEqual([1, 4]);
  });

  it('are named only by RTK_SETTINGS_FILES', () => {
    const sites: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (rel === TABLE_FILE) continue;
        const text = readFileSync(file, 'utf8');
        if (![...PATHS].some((p) => text.includes(p))) continue;
        for (const line of literalLines(text, file.endsWith('.tsx'))) sites.push(`${rel}:${line}`);
      }
    }
    expect(sites, 'Read these paths from RTK_SETTINGS_FILES (or RTK_SETTINGS_PATHS).').toEqual([]);
  }, 60_000);
});
