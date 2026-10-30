import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
} from '@haive/shared';
import {
  ParkedFileError,
  readFileNoFollow,
  rewriteFileIfNoFollow,
  updateFileNoFollow,
} from '@haive/shared/fs-safe';
import {
  importRulesFiles,
  importRulesFilesFor,
  isLinkToAgentsMd,
  readUpgradeFile,
  RTK_BLOCK_FILES,
  RULES_FILE_READ_CAP,
  RULES_IMPORT_LINE,
  rulesImportState,
} from '@haive/shared/rules-files';
import { gitGaveNoAnswer, gitRun } from '../../../repo/git-exec.js';

export { isLinkToAgentsMd, RULES_IMPORT_LINE };

export interface RulesPlan {
  /** The repository's `haive:cli-rules` block for AGENTS.md: its rules override, else Haive's
   *  default rules; null when the override is empty. */
  agentsRulesBlock: string | null;
  /** Files (CLAUDE.md, GEMINI.md) that receive only an `@AGENTS.md` import. */
  importFiles: string[];
  /** Files that receive a full duplicate of AGENTS.md (project-info + rules) —
   *  for CLIs supporting neither native AGENTS.md nor `@` imports. Unused by
   *  the current adapter set. */
  copyFiles: string[];
}

/** Decide what each CLI's rules file gets, given the enabled providers' adapter
 *  rules-file metadata and the repository's rules override (`null` follows the
 *  default rules). AGENTS.md is the single source of truth, and its rules are the
 *  repository's, never a provider's; import-mode files (CLAUDE.md, GEMINI.md) just
 *  point at it via `@AGENTS.md`; native-mode files (rulesFile === 'AGENTS.md') need
 *  nothing extra. */
export function planRulesFiles(
  providers: ReadonlyArray<{
    rulesFile: string;
    rulesFileMode: 'native' | 'import' | 'copy';
  }>,
  agentRulesOverride: string | null | undefined,
): RulesPlan {
  const agentsRulesBlock = buildRepoCliRulesBlock(agentRulesOverride);
  const copyFiles = new Set<string>();
  for (const p of providers) {
    if (p.rulesFile !== 'AGENTS.md' && p.rulesFileMode === 'copy') copyFiles.add(p.rulesFile);
  }
  return { agentsRulesBlock, importFiles: importRulesFiles(providers), copyFiles: [...copyFiles] };
}

export type RulesImportStubResult = 'created' | 'appended' | 'unchanged' | 'skipped-link';

export interface RulesImportStubOutcome {
  file: string;
  result: RulesImportStubResult | 'refused';
  error?: string;
}

/** Make `rel` import AGENTS.md: create it holding the import line alone, or append the line to a
 *  file that lacks it. Any other link is refused by `updateFileNoFollow`, which throws: a rules
 *  file pointing somewhere nobody here chose is exactly what must not be written through. */
export async function ensureRulesImportStub(
  repoPath: string,
  rel: string,
  opts: { maxBytes?: number } = {},
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
    { create: true, createParents: true, maxBytes: opts.maxBytes },
  );
  if (result === 'created') return 'created';
  return result === 'updated' ? 'appended' : 'unchanged';
}

/** Ensure each file imports AGENTS.md, reading none past the cap. A refusal or an I/O error is
 *  recorded per file and never thrown, so one bad rules file cannot stop the rest, or the caller's
 *  own work after this. */
export async function restoreRulesImportStubs(
  repoPath: string,
  files: readonly string[],
): Promise<RulesImportStubOutcome[]> {
  const outcomes: RulesImportStubOutcome[] = [];
  for (const file of files) {
    try {
      outcomes.push({
        file,
        result: await ensureRulesImportStub(repoPath, file, { maxBytes: RULES_FILE_READ_CAP }),
      });
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

/** `content` without its RTK blocks, each taken with the newline 07 wrote after it, beside the
 *  blocks it took, or null when it holds none. */
export function withoutRtkBlocks(content: string): { text: string; blocks: string[] } | null {
  let text = content;
  const blocks: string[] = [];
  for (;;) {
    const start = text.indexOf(RTK_REF_MARKER_START);
    if (start === -1) break;
    const endAt = text.indexOf(RTK_REF_MARKER_END, start);
    if (endAt === -1) break;
    const end = endAt + RTK_REF_MARKER_END.length;
    const cut = text[end] === '\n' ? end + 1 : end;
    blocks.push(text.slice(start, cut));
    text = text.slice(0, start) + text.slice(cut);
  }
  return blocks.length === 0 ? null : { text, blocks };
}

/** The template id and kind 02 records an RTK strip under. No manifest item has it, so nothing that
 *  reads a template's rows takes the record for one of them. */
export const RTK_BLOCK_RECORD = 'rtk-block';

export interface RtkBlockStripOutcome {
  file: string;
  result: 'stripped' | 'none' | 'skipped-link' | 'refused';
  error?: string;
}

/** Why an RTK pass left a rules file as it was without judging it. */
function rtkRefusal(notUtf8: boolean): string {
  return notUtf8
    ? 'it is not valid UTF-8, so writing it back would change more than the block'
    : `it could not be read (a link, not a regular file, or larger than ${RULES_FILE_READ_CAP} bytes)`;
}

/** Take the RTK block out of each rules file that holds one. `record` runs before the file changes,
 *  with what it held and what the strip leaves, and a throw there leaves the file as it was. A
 *  `CLAUDE.md -> AGENTS.md` link is AGENTS.md's own pass, and any other link is refused, as is a
 *  file past the read cap or one that is not UTF-8. A refusal or an I/O error is recorded per file
 *  and never thrown. */
export async function stripRtkBlocks(
  repoPath: string,
  record: (file: string, before: string, after: string) => Promise<void>,
): Promise<RtkBlockStripOutcome[]> {
  const outcomes: RtkBlockStripOutcome[] = [];
  for (const file of RTK_BLOCK_FILES) {
    try {
      if (await isLinkToAgentsMd(repoPath, file)) {
        outcomes.push({ file, result: 'skipped-link' });
        continue;
      }
      let read = false;
      let notUtf8 = false;
      const result = await rewriteFileIfNoFollow(
        repoPath,
        file,
        async (data) => {
          read = true;
          const before = data.toString('utf8');
          if (!Buffer.from(before, 'utf8').equals(data)) {
            notUtf8 = true;
            return null;
          }
          const stripped = withoutRtkBlocks(before);
          if (stripped === null) return null;
          await record(file, before, stripped.text);
          return Buffer.from(stripped.text, 'utf8');
        },
        { maxBytes: RULES_FILE_READ_CAP },
      );
      if (result === 'kept' && (!read || notUtf8)) {
        outcomes.push({ file, result: 'refused', error: rtkRefusal(notUtf8) });
      } else {
        outcomes.push({ file, result: result === 'rewritten' ? 'stripped' : 'none' });
      }
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

export type RtkBlockRestore =
  | { outcome: 'restored'; held: string; left: string }
  | { outcome: 'standing' }
  | { outcome: 'absent' }
  | { outcome: 'kept'; reason: string };

/** Put back the RTK blocks a strip took out of `before`, only while no RTK block stands in the
 *  file: all of `before` while the file still holds what the strip left (`leftHash`), else the
 *  blocks appended the way 07 appends one. The same blocks standing there already count as put
 *  back, and a file removed since stays removed. */
export async function restoreRtkBlocks(
  repoPath: string,
  file: string,
  before: string,
  leftHash: string | null,
): Promise<RtkBlockRestore> {
  const blocks = (withoutRtkBlocks(before)?.blocks ?? []).join('');
  let notUtf8 = false;
  let standing: string | null = null;
  let rewrote = false;
  let heldText = '';
  let leftText = '';
  let result;
  try {
    result = await rewriteFileIfNoFollow(
      repoPath,
      file,
      (data) => {
        const text = data.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(data)) {
          notUtf8 = true;
          return null;
        }
        const held = withoutRtkBlocks(text);
        if (held !== null) {
          standing = held.blocks.join('');
          return null;
        }
        rewrote = true;
        heldText = text;
        if (leftHash !== null && sha256Hex(normalizeContent(text)) === leftHash) {
          leftText = before;
        } else {
          const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
          leftText = `${text}${sep}${blocks}`;
        }
        return Buffer.from(leftText, 'utf8');
      },
      { maxBytes: RULES_FILE_READ_CAP },
    );
  } catch (err) {
    if (!(err instanceof ParkedFileError)) throw err;
    const parked = rewrote ? 'what the rollback put back' : 'what stood there before';
    return {
      outcome: 'kept',
      reason: `it was saved while the rollback judged it, and ${parked} is at ${err.parkedAt}`,
    };
  }
  if (result === 'absent') return { outcome: 'absent' };
  if (result === 'rewritten') return { outcome: 'restored', held: heldText, left: leftText };
  if (standing === null) return { outcome: 'kept', reason: rtkRefusal(notUtf8) };
  return standing === blocks
    ? { outcome: 'standing' }
    : { outcome: 'kept', reason: 'it holds another RTK block now' };
}

/** The template id and kind 02 records an RTK block put back under, beside `RTK_BLOCK_RECORD`. */
export const RTK_BLOCK_RESTORE_RECORD = 'rtk-block-restore';

/** The one file 07 writes the RTK block into, and so the only one an upgrade offers it back to. */
export const RTK_BLOCK_HOME = 'AGENTS.md';

/** `[RTK_BLOCK_HOME]` when Haive's own newest record for it is a strip (a restore after it settles
 *  the question) and the file reads as text with no RTK block standing, else none. */
export async function restorableRtkBlockFiles(
  db: Database,
  repoPath: string,
  repositoryId: string,
): Promise<string[]> {
  // A reset and re-onboarding write the block with no record, so only records since then count.
  const [repo] = await db
    .select({ resetAt: schema.repositories.onboardingResetAt })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const [newest] = await db
    .select({ templateKind: schema.onboardingArtifacts.templateKind })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        eq(schema.onboardingArtifacts.diskPath, RTK_BLOCK_HOME),
        inArray(schema.onboardingArtifacts.templateKind, [
          RTK_BLOCK_RECORD,
          RTK_BLOCK_RESTORE_RECORD,
        ]),
        ...(repo?.resetAt ? [gt(schema.onboardingArtifacts.generatedAt, repo.resetAt)] : []),
      ),
    )
    .orderBy(desc(schema.onboardingArtifacts.generatedAt))
    .limit(1);
  if (newest?.templateKind !== RTK_BLOCK_RECORD) return [];
  const read = await readUpgradeFile(repoPath, RTK_BLOCK_HOME);
  return read.kind === 'text' && !read.text.includes(RTK_REF_MARKER_START) ? [RTK_BLOCK_HOME] : [];
}

export interface RtkBlockPutBackOutcome {
  result: 'appended' | 'standing' | 'absent' | 'refused';
  error?: string;
}

/** Append `block` to `file` the way 07 appends one, only while no RTK block stands in it. `record`
 *  runs before the file changes, with what it held and what the append leaves, and a throw there
 *  leaves the file as it was. A refusal or an I/O error is returned and never thrown. */
export async function appendRtkBlock(
  repoPath: string,
  file: string,
  block: string,
  record: (before: string, after: string) => Promise<void>,
): Promise<RtkBlockPutBackOutcome> {
  let notUtf8 = false;
  let standing = false;
  try {
    const result = await rewriteFileIfNoFollow(
      repoPath,
      file,
      async (data) => {
        const before = data.toString('utf8');
        if (!Buffer.from(before, 'utf8').equals(data)) {
          notUtf8 = true;
          return null;
        }
        if (before.includes(RTK_REF_MARKER_START)) {
          standing = true;
          return null;
        }
        const sep = before.length === 0 || before.endsWith('\n') ? '' : '\n';
        const after = `${before}${sep}${block}`;
        await record(before, after);
        return Buffer.from(after, 'utf8');
      },
      { maxBytes: RULES_FILE_READ_CAP },
    );
    if (result === 'rewritten') return { result: 'appended' };
    if (result === 'absent') return { result: 'absent' };
    if (standing) return { result: 'standing' };
    return { result: 'refused', error: rtkRefusal(notUtf8) };
  } catch (err) {
    return { result: 'refused', error: err instanceof Error ? err.message : String(err) };
  }
}

export type RtkBlockTakenOut =
  | { outcome: 'removed'; held: string; left: string }
  | { outcome: 'already' }
  | { outcome: 'absent' }
  | { outcome: 'kept'; reason: string };

/** Take back out the block a restore put in: write `before` back, only while the file still holds
 *  what the restore left (`leftHash`). A file that already holds `before` is an earlier attempt of
 *  the same rollback, and anything else is the person's and stays. */
export async function takeOutRestoredRtkBlock(
  repoPath: string,
  file: string,
  before: string,
  leftHash: string,
): Promise<RtkBlockTakenOut> {
  const beforeHash = sha256Hex(normalizeContent(before));
  let notUtf8 = false;
  let already = false;
  let changed = false;
  let held = '';
  let result;
  try {
    result = await rewriteFileIfNoFollow(
      repoPath,
      file,
      (data) => {
        const text = data.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(data)) {
          notUtf8 = true;
          return null;
        }
        const hash = sha256Hex(normalizeContent(text));
        if (hash === leftHash) {
          held = text;
          return Buffer.from(before, 'utf8');
        }
        if (hash === beforeHash) already = true;
        else changed = true;
        return null;
      },
      { maxBytes: RULES_FILE_READ_CAP },
    );
  } catch (err) {
    if (!(err instanceof ParkedFileError)) throw err;
    return {
      outcome: 'kept',
      reason: `it was saved while the rollback judged it, and what stood there is at ${err.parkedAt}`,
    };
  }
  if (result === 'absent') return { outcome: 'absent' };
  if (result === 'rewritten') return { outcome: 'removed', held, left: before };
  if (already) return { outcome: 'already' };
  return {
    outcome: 'kept',
    reason: changed ? 'it was changed after the upgrade' : rtkRefusal(notUtf8),
  };
}

/** Which of `files` lacks the import where an upgrade can add it, as upgrade-status counts them: a
 *  link elsewhere and a file that cannot be read whole are left out, since the apply refuses both. */
export async function missingRulesImportStubs(
  repoPath: string,
  files: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    if ((await rulesImportState(repoPath, file)) === 'missing') missing.push(file);
  }
  return missing;
}

/** Import-mode rules files for the user's currently ENABLED providers, by the same rule step 07
 *  applies. Read from the live rows rather than an onboarding snapshot, so an upgrade restores
 *  what today's providers need. */
export async function enabledImportRulesFiles(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.cliProviders.name })
    .from(schema.cliProviders)
    .where(and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.enabled, true)));
  return importRulesFilesFor(rows.map((r) => r.name));
}

/** A rules file the repository keeps out of git, such as a personal CLAUDE.md, stays out of a
 *  forced stage too. A tracked file is never reported ignored; a check that gave no answer throws. */
export async function isGitIgnored(repoPath: string, rel: string): Promise<boolean> {
  const res = await gitRun(repoPath, ['check-ignore', '-q', '--', rel]);
  if (gitGaveNoAnswer(res)) {
    throw new Error(`could not check whether ${rel} is ignored: git gave no answer`);
  }
  return res.code === 0;
}

/** `paths` without the rules and settings files git ignores, each dropped one reported: the
 *  `git add -f` the rest needs would otherwise commit a file the repository keeps out of history on
 *  purpose. Call it after any `git init`, since before one there is no repository to ask. */
export async function dropIgnoredRulesFiles(
  repoPath: string,
  paths: readonly string[],
  checked: ReadonlySet<string>,
): Promise<{ keep: string[]; warnings: string[] }> {
  const keep: string[] = [];
  const warnings: string[] = [];
  for (const rel of paths) {
    if (checked.has(rel) && (await isGitIgnored(repoPath, rel))) {
      warnings.push(`${rel} is ignored by git, so it stays out of this commit`);
    } else {
      keep.push(rel);
    }
  }
  return { keep, warnings };
}

/** The cli-rules region of AGENTS.md on disk: null with no file or no region, `unreadable` for a
 *  link, a refused read or a file past the cap. */
export async function readAgentsRulesRegion(
  repoPath: string,
): Promise<{ region: string | null } | { unreadable: string }> {
  let read;
  try {
    read = await readFileNoFollow(repoPath, CLI_RULES_DISK_PATH, {
      strict: true,
      maxBytes: RULES_FILE_READ_CAP,
    });
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
  if (read === null) return { region: null };
  if (read.truncated) return { unreadable: `larger than ${RULES_FILE_READ_CAP} bytes` };
  return { region: extractRegion(read.data.toString('utf8'), CLI_RULES_START, CLI_RULES_END) };
}

/** What a cli-rules artifact row records for the region on disk. It records the region's own
 *  bytes exactly as they stand (every hash is over their normalized form), and claims them as
 *  Haive's only when they are a render: this one, or one an earlier onboarding or upgrade of the
 *  repository wrote. Otherwise the row keeps the render's hash, so the upgrade plan offers the
 *  region as a conflict instead of overwriting it. */
export function cliRulesRegionRecord(
  region: string,
  render: string,
  earlierRenderHashes: ReadonlySet<string>,
): { content: string; templateContentHash: string; writtenHash: string; haiveWritten: boolean } {
  const regionHash = sha256Hex(normalizeContent(region));
  const renderHash = sha256Hex(normalizeContent(render));
  const haiveWritten = regionHash === renderHash || earlierRenderHashes.has(regionHash);
  return {
    content: region,
    templateContentHash: regionHash,
    writtenHash: haiveWritten ? regionHash : renderHash,
    haiveWritten,
  };
}

/** The written hashes of the repository's earlier cli-rules rows that hold a render. Backfill
 *  and rollback rows are left out (an import marker is a backfill row): their hash is whatever
 *  was on disk. */
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
