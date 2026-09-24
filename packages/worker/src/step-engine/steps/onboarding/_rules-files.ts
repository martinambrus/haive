import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  buildCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import {
  lstatNoFollow,
  readFileNoFollow,
  readLinkNoFollow,
  readTextNoFollow,
  updateFileNoFollow,
} from '@haive/shared/fs-safe';
import { cliAdapterRegistry } from '../../../cli-adapters/registry.js';
import type { CliProviderName } from '../../../cli-adapters/types.js';

const execFileAsync = promisify(execFile);

export interface RulesPlan {
  /** Merged `haive:cli-rules` block for AGENTS.md, or null when no enabled
   *  provider has rules content. */
  agentsRulesBlock: string | null;
  /** Files (CLAUDE.md, GEMINI.md) that receive only an `@AGENTS.md` import. */
  importFiles: string[];
  /** Files that receive a full duplicate of AGENTS.md (project-info + rules) —
   *  for CLIs supporting neither native AGENTS.md nor `@` imports. Unused by
   *  the current adapter set. */
  copyFiles: string[];
}

/** Decide what each CLI's rules file gets, given the enabled providers joined
 *  with their adapter rules-file metadata. AGENTS.md is the single source of
 *  truth (every provider's rules merged + trim-equal deduped); import-mode
 *  files (CLAUDE.md, GEMINI.md) just point at it via `@AGENTS.md`; native-mode
 *  files (rulesFile === 'AGENTS.md') need nothing extra. */
export function planRulesFiles(
  providers: ReadonlyArray<{
    rulesContent: string;
    rulesFile: string;
    rulesFileMode: 'native' | 'import' | 'copy';
  }>,
): RulesPlan {
  const agentsRulesBlock = buildCliRulesBlock(providers.map((p) => p.rulesContent));
  const importFiles = new Set<string>();
  const copyFiles = new Set<string>();
  for (const p of providers) {
    if (p.rulesFile === 'AGENTS.md') continue;
    if (p.rulesFileMode === 'import') importFiles.add(p.rulesFile);
    else if (p.rulesFileMode === 'copy') copyFiles.add(p.rulesFile);
  }
  return { agentsRulesBlock, importFiles: [...importFiles], copyFiles: [...copyFiles] };
}

/** The line an import-mode rules file carries so its CLI loads AGENTS.md. */
export const RULES_IMPORT_LINE = '@AGENTS.md';

export type RulesImportStubResult = 'created' | 'appended' | 'unchanged' | 'skipped-link';

export interface RulesImportStubOutcome {
  file: string;
  result: RulesImportStubResult | 'refused';
  error?: string;
}

/** A repo may carry `CLAUDE.md -> AGENTS.md`: the convention predates Haive, and AGENTS.md is
 *  written at its own path, so such a link already delivers the rules and is left alone. */
export async function isLinkToAgentsMd(repoPath: string, rel: string): Promise<boolean> {
  if ((await lstatNoFollow(repoPath, rel))?.kind !== 'symlink') return false;
  const target = await readLinkNoFollow(repoPath, rel);
  return target === 'AGENTS.md' || target === './AGENTS.md';
}

/** Make `rel` import AGENTS.md: create it holding the import line alone, or append the line to a
 *  file that lacks it. Any other link is refused by `updateFileNoFollow`, which throws: a rules
 *  file pointing somewhere nobody here chose is exactly what must not be written through. */
export async function ensureRulesImportStub(
  repoPath: string,
  rel: string,
): Promise<RulesImportStubResult> {
  if (await isLinkToAgentsMd(repoPath, rel)) return 'skipped-link';
  const result = await updateFileNoFollow(
    repoPath,
    rel,
    (current) => {
      if (current === null) return `${RULES_IMPORT_LINE}\n`;
      if (current.includes(RULES_IMPORT_LINE)) return null;
      const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      return `${current}${sep}${RULES_IMPORT_LINE}\n`;
    },
    { create: true, createParents: true },
  );
  if (result === 'created') return 'created';
  return result === 'updated' ? 'appended' : 'unchanged';
}

/** Ensure each file imports AGENTS.md. A refusal or an I/O error is recorded per file and never
 *  thrown, so one bad rules file cannot stop the rest, or the caller's own work after this. */
export async function restoreRulesImportStubs(
  repoPath: string,
  files: readonly string[],
): Promise<RulesImportStubOutcome[]> {
  const outcomes: RulesImportStubOutcome[] = [];
  for (const file of files) {
    try {
      outcomes.push({ file, result: await ensureRulesImportStub(repoPath, file) });
    } catch (err) {
      outcomes.push({
        file,
        result: 'refused',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/** Which of `files` does not import AGENTS.md right now. A file that cannot be read counts as
 *  missing; the apply step records what then happened to it. */
export async function missingRulesImportStubs(
  repoPath: string,
  files: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    try {
      if (await isLinkToAgentsMd(repoPath, file)) continue;
      const text = await readTextNoFollow(repoPath, file);
      if (text === null || !text.includes(RULES_IMPORT_LINE)) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return missing;
}

/** Import-mode rules files for the user's currently ENABLED providers, by the same rule step 07
 *  applies. Read from the live rows rather than an onboarding snapshot, so an upgrade restores
 *  what today's providers need. */
export async function enabledImportRulesFiles(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.cliProviders.name, rulesContent: schema.cliProviders.rulesContent })
    .from(schema.cliProviders)
    .where(and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.enabled, true)));
  const joined = rows
    .filter((r) => cliAdapterRegistry.has(r.name as CliProviderName))
    .map((r) => {
      const adapter = cliAdapterRegistry.get(r.name as CliProviderName);
      return {
        rulesContent: r.rulesContent,
        rulesFile: adapter.rulesFile,
        rulesFileMode: adapter.rulesFileMode,
      };
    });
  return planRulesFiles(joined).importFiles;
}

/** A rules file the repository keeps out of git, such as a personal CLAUDE.md, stays out of a
 *  forced stage too. A tracked file is never reported ignored, and a failed check answers false. */
export async function isGitIgnored(repoPath: string, rel: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', rel], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/** `paths` without the rules files git ignores, each dropped one reported: the `git add -f` the
 *  rest needs would otherwise commit a file the repository keeps out of history on purpose. Call it
 *  after any `git init`, since before one there is no repository to ask. */
export async function dropIgnoredRulesFiles(
  repoPath: string,
  paths: readonly string[],
  rulesFiles: ReadonlySet<string>,
): Promise<{ keep: string[]; warnings: string[] }> {
  const keep: string[] = [];
  const warnings: string[] = [];
  for (const rel of paths) {
    if (rulesFiles.has(rel) && (await isGitIgnored(repoPath, rel))) {
      warnings.push(`${rel} is ignored by git, so it stays out of this commit`);
    } else {
      keep.push(rel);
    }
  }
  return { keep, warnings };
}

/** Past any rules block; a larger AGENTS.md is one no comparison is attempted on. */
export const AGENTS_MD_READ_CAP = 1024 * 1024;

/** The cli-rules region of AGENTS.md on disk: null with no file or no region, `unreadable` for a
 *  link, a refused read or a file past the cap. */
export async function readAgentsRulesRegion(
  repoPath: string,
): Promise<{ region: string | null } | { unreadable: string }> {
  let read;
  try {
    read = await readFileNoFollow(repoPath, CLI_RULES_DISK_PATH, {
      strict: true,
      maxBytes: AGENTS_MD_READ_CAP,
    });
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
  if (read === null) return { region: null };
  if (read.truncated) return { unreadable: `larger than ${AGENTS_MD_READ_CAP} bytes` };
  return { region: extractRegion(read.data.toString('utf8'), CLI_RULES_START, CLI_RULES_END) };
}

/** What a cli-rules artifact row records for the region on disk. It records the region's own
 *  bytes, and claims them as Haive's only when they are a render: this one, or one an earlier
 *  onboarding or upgrade of the repository wrote. Otherwise the row keeps the render's hash, so
 *  the upgrade plan offers the region as a conflict instead of overwriting it. */
export function cliRulesRegionRecord(
  region: string,
  render: string,
  earlierRenderHashes: ReadonlySet<string>,
): { content: string; templateContentHash: string; writtenHash: string; haiveWritten: boolean } {
  const content = normalizeContent(region);
  const regionHash = sha256Hex(content);
  const renderHash = sha256Hex(normalizeContent(render));
  const haiveWritten = regionHash === renderHash || earlierRenderHashes.has(regionHash);
  return {
    content,
    templateContentHash: regionHash,
    writtenHash: haiveWritten ? regionHash : renderHash,
    haiveWritten,
  };
}

/** The written hashes of the repository's earlier cli-rules rows that hold a render. Backfill
 *  and rollback rows are left out: their hash is whatever was on disk. */
export async function loadCliRulesRenderHashes(
  db: Database,
  repositoryId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ writtenHash: schema.onboardingArtifacts.writtenHash })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        eq(schema.onboardingArtifacts.templateKind, CLI_RULES_TEMPLATE_KIND),
        inArray(schema.onboardingArtifacts.source, ['onboarding', 'upgrade']),
      ),
    );
  return new Set(rows.map((r) => r.writtenHash));
}
