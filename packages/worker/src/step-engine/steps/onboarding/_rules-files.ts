import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { buildCliRulesBlock } from '@haive/shared';
import {
  lstatNoFollow,
  readLinkNoFollow,
  readTextNoFollow,
  updateFileNoFollow,
} from '@haive/shared/fs-safe';
import { cliAdapterRegistry } from '../../../cli-adapters/registry.js';
import type { CliProviderName } from '../../../cli-adapters/types.js';

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
