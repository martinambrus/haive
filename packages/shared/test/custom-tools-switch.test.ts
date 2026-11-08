import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS } from '../src/config/config.service.js';
import { resolveCustomToolsEnabled } from '../src/modularity-server/custom-tools-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next']);
const DIRECT_READ = /getBoolean\(\s*CONFIG_KEYS\.CUSTOM_MCP_TOOLS_ENABLED/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(full));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function directReaders(roots: string[], base: string): string[] {
  return roots
    .flatMap(walk)
    .filter((file) => DIRECT_READ.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(base, file).split(path.sep).join('/'))
    .sort();
}

function repoSrcRoots(): string[] {
  return ['packages', 'modules'].flatMap((group) =>
    readdirSync(path.join(REPO_ROOT, group))
      .map((name) => path.join(REPO_ROOT, group, name, 'src'))
      .filter((src) => existsSync(src)),
  );
}

describe('resolveCustomToolsEnabled', () => {
  it('returns what getBoolean resolves, reading the key once with default on', async () => {
    const getBoolean = vi.fn().mockResolvedValue(false);
    await expect(resolveCustomToolsEnabled({ getBoolean })).resolves.toBe(false);
    expect(getBoolean).toHaveBeenCalledTimes(1);
    expect(getBoolean).toHaveBeenCalledWith(CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, true);
  });

  it('rejects with the same error instance when the config read fails', async () => {
    const boom = new Error('config down');
    const getBoolean = vi.fn().mockRejectedValue(boom);
    await expect(resolveCustomToolsEnabled({ getBoolean })).rejects.toBe(boom);
  });

  it('is the only source file that reads the switch directly', () => {
    expect(directReaders(repoSrcRoots(), REPO_ROOT)).toEqual([
      'packages/shared/src/modularity-server/custom-tools-switch.ts',
    ]);
  });

  it('negative control: the scan reports a direct read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'custom-tools-switch-'));
    try {
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(
        path.join(dir, 'src', 'site.ts'),
        'export const on = () => cfg.getBoolean(CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, true);\n',
      );
      expect(directReaders([path.join(dir, 'src')], dir)).toEqual(['src/site.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
