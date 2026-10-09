import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BINARY_EXTENSIONS = new Set(['.png']);

describe('tracked text files', () => {
  // grep reads a file holding a NUL byte as binary, and ripgrep skips it without a word.
  // It reads every tracked file, which can outlast the 5 s default on a cold page cache.
  it('hold no NUL byte', () => {
    const listing = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const offenders: string[] = [];
    for (const rel of listing.split(String.fromCharCode(0))) {
      if (!rel || BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
      const abs = path.join(REPO_ROOT, rel);
      if (!lstatSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
      const bytes = readFileSync(abs);
      const at = bytes.indexOf(0);
      if (at === -1) continue;
      offenders.push(`${rel}:${bytes.subarray(0, at).toString('utf8').split('\n').length}`);
    }
    expect(offenders).toEqual([]);
  }, 20_000);
});
