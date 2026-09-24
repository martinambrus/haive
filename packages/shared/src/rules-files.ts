import type { CliProviderName } from './types/index.js';
import { CLI_PROVIDER_CATALOG, type CliRulesFileMode } from './cli-providers/catalog.js';
import { lstatNoFollow, readFileNoFollow, readLinkNoFollow } from './fs-safe.js';
import { extractRegion, RTK_REF_MARKER_END, RTK_REF_MARKER_START } from './templates/cli-rules.js';

// Shared so the worker's upgrade steps and the api's upgrade status name the same files. Node-only
// and outside the root barrel, like `fs-safe`, which refuses to load anywhere but Linux.

/** The line an import-mode rules file carries so its CLI loads AGENTS.md. */
export const RULES_IMPORT_LINE = '@AGENTS.md';

/** A rules file larger than this is one no import check is attempted on. */
export const RULES_FILE_READ_CAP = 1024 * 1024;

/** The files that must import AGENTS.md for these providers: each import-mode `rulesFile`, once,
 *  in provider order. */
export function importRulesFiles(
  providers: ReadonlyArray<{ rulesFile: string; rulesFileMode: CliRulesFileMode }>,
): string[] {
  const files = new Set<string>();
  for (const p of providers) {
    if (p.rulesFile !== 'AGENTS.md' && p.rulesFileMode === 'import') files.add(p.rulesFile);
  }
  return [...files];
}

/** `importRulesFiles` for providers named in the catalog. A name it does not know needs none. */
export function importRulesFilesFor(names: readonly string[]): string[] {
  return importRulesFiles(names.flatMap((n) => CLI_PROVIDER_CATALOG[n as CliProviderName] ?? []));
}

/** A repo may carry `CLAUDE.md -> AGENTS.md`: the convention predates Haive, and AGENTS.md is
 *  written at its own path, so such a link already delivers the rules and is left alone. */
export async function isLinkToAgentsMd(repoPath: string, rel: string): Promise<boolean> {
  if ((await lstatNoFollow(repoPath, rel))?.kind !== 'symlink') return false;
  const target = await readLinkNoFollow(repoPath, rel);
  return target === 'AGENTS.md' || target === './AGENTS.md';
}

/** `present` holds the import line or links to AGENTS.md; `linked-elsewhere` is any other link,
 *  which no upgrade writes through; `unreadable` is a file that cannot be read whole. */
export type RulesImportState = 'present' | 'missing' | 'linked-elsewhere' | 'unreadable';

export async function rulesImportState(repoPath: string, rel: string): Promise<RulesImportState> {
  try {
    const entry = await lstatNoFollow(repoPath, rel, { strict: true });
    if (entry === null) return 'missing';
    if (entry.kind === 'symlink') {
      return (await isLinkToAgentsMd(repoPath, rel)) ? 'present' : 'linked-elsewhere';
    }
    const read = await readFileNoFollow(repoPath, rel, {
      strict: true,
      maxBytes: RULES_FILE_READ_CAP,
    });
    if (read === null) return 'missing';
    if (read.truncated) return 'unreadable';
    return read.data.toString('utf8').includes(RULES_IMPORT_LINE) ? 'present' : 'missing';
  } catch {
    return 'unreadable';
  }
}

/** Where an RTK block can sit: the awareness block 07 writes into AGENTS.md, and the `@RTK.md`
 *  import older onboardings put between the same markers in the rules stubs. */
export const RTK_BLOCK_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

async function holdsRtkBlock(repoPath: string, rel: string): Promise<boolean> {
  try {
    const read = await readFileNoFollow(repoPath, rel, {
      strict: true,
      maxBytes: RULES_FILE_READ_CAP,
    });
    if (read === null || read.truncated) return false;
    const text = read.data.toString('utf8');
    return extractRegion(text, RTK_REF_MARKER_START, RTK_REF_MARKER_END) !== null;
  } catch {
    return false;
  }
}

/** The rules files that hold an RTK block. A link, and a file that cannot be read whole, claim
 *  nothing: no upgrade writes through a link, and it reports a file it could not check. */
export async function rtkBlockFiles(repoPath: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of RTK_BLOCK_FILES) {
    if (await holdsRtkBlock(repoPath, file)) found.push(file);
  }
  return found;
}
