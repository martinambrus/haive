import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDOR_TOKEN_FUNCTIONS = [
  'getConnectionAccessToken',
  'getConnectionCredential',
  'decryptConnectionTokens',
  'encryptConnectionTokens',
] as const;

export const WORKER_SRC = fileURLToPath(new URL('../../src', import.meta.url));

const NAMED = new RegExp(`\\b(?:${VENDOR_TOKEN_FUNCTIONS.join('|')})\\b`, 'g');

/** Prose may name what the worker must not call; only code can call it. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The vendor-token functions a source text names in code, however it imports or reaches them. */
export function vendorTokenUses(source: string): string[] {
  return [...new Set(codeOnly(source).match(NAMED) ?? [])];
}

/** `file: name, name` for every file that names one. */
export function offendersIn(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, source]) => {
    const used = vendorTokenUses(source);
    return used.length > 0 ? [`${file}: ${used.join(', ')}`] : [];
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === 'node_modules' || entry === 'dist' ? [] : filesUnder(full);
    }
    return [full];
  });
}

export function workerSources(): Record<string, string> {
  return Object.fromEntries(
    filesUnder(WORKER_SRC).map((file) => [relative(WORKER_SRC, file), readFileSync(file, 'utf8')]),
  );
}
