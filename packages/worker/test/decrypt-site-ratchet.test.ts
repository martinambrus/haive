import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Provider secrets are decrypted in two worker files. resolveProviderSecrets skips the worker-only
// names before it decrypts, so a decrypt anywhere else could hand one of them to a container. This
// pins, per source file, how often a decrypt primitive is named (import, call, alias or namespace
// member), exactly, so a new decrypt site lands where a reviewer sees it and the baseline cannot
// drift stale in either direction. The primitives are the shared envelope opener, the two it is
// built from, and node:crypto's own decipher, since any of them can open a provider secret row.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const NAMES = new Set([
  'envelopeDecrypt',
  'decryptDek',
  'decrypt',
  'tryDecrypt',
  'createDecipheriv',
]);
const SOURCE = /\.[cm]?tsx?$/;
const TEST_FILE = /\.test\.[cm]?tsx?$/;

const PINNED: Record<string, number> = {
  // The import, and the decrypts of resolveProviderSecrets and readProviderSecret.
  'secrets/provider-secrets.ts': 3,
  // The import, and the usage-grant holder's read of the one worker-only secret. It feeds the
  // usage poller and is never merged into an env.
  'usage-window/usage-grant-set.ts': 2,
  // Repository credential rows: their own table and data key, never a provider secret. Two
  // imports, the data-key decrypt and the two field decrypts.
  'repo/credentials.ts': 5,
};

function countNamed(fileName: string, text: string): number {
  if (![...NAMES].some((name) => text.includes(name))) return 0;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && NAMES.has(node.text)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(full);
    }
    return SOURCE.test(entry.name) && !TEST_FILE.test(entry.name) ? [full] : [];
  });
}

describe('provider secret decrypt sites', () => {
  it('counts the forms a decrypt can take and nothing in prose', () => {
    const count = (code: string) => countNamed('a.ts', code);
    expect(
      count(`import { envelopeDecrypt } from '@haive/shared';\nenvelopeDecrypt(value, kek);`),
    ).toBe(2);
    expect(count(`import * as shared from '@haive/shared';\nshared.decryptDek(v, k);`)).toBe(1);
    expect(count(`import { decrypt as open } from '@haive/shared';\nopen(v, k);`)).toBe(1);
    expect(count(`const open = shared['tryDecrypt'];`)).toBe(1);
    expect(count(`import { createDecipheriv } from 'node:crypto';`)).toBe(1);
    expect(count(`// decrypt is not called here\nconst note = 'no envelopeDecrypt';`)).toBe(0);
  });

  it('are exactly the pinned worker files', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(SRC)) {
      const count = countNamed(file, readFileSync(file, 'utf8'));
      if (count > 0) found[path.relative(SRC, file).split(path.sep).join('/')] = count;
    }
    const problems: string[] = [];
    for (const [file, count] of Object.entries(found)) {
      const pinned = PINNED[file] ?? 0;
      if (count !== pinned) {
        problems.push(`${file}: names a decrypt primitive ${count} time(s), pinned ${pinned}`);
      }
    }
    for (const file of Object.keys(PINNED)) {
      if (!(file in found))
        problems.push(`${file}: pinned but no longer names a decrypt primitive`);
    }
    expect(
      problems,
      'Decrypt provider secrets in resolveProviderSecrets or readProviderSecret (worker/src/secrets/provider-secrets.ts), which skip the worker-only names. If another decrypt site is intended, pin it here with the reason it can never reach a container env.',
    ).toEqual([]);
  });
});
