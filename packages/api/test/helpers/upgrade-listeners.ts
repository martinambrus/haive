import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One listener inventory for the origin coverage and shared-authenticator ratchets. */
export function upgradeListenerFiles(): string[] {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  return walk(src)
    .filter((file) => file.endsWith('.ts') && readFileSync(file, 'utf8').includes("on('upgrade'"))
    .map((file) => relative(src, file))
    .sort();
}
