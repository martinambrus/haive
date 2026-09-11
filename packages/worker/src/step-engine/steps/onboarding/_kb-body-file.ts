import { chown, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where a KB miner stages an entry's body before the step files it. Inside the
 *  workspace so the agent can write it with ordinary tools, and under `.haive/` beside
 *  the spec artifacts rather than in the knowledge base itself — a draft that never
 *  reaches `apply` must not look like a published KB page. */
export const KB_DRAFT_DIR = '.haive/kb-draft';

export interface KbSection {
  heading: string;
  body: string;
}

/** Parse `entryToMarkdown`'s own output back into sections.
 *
 *  Safe to round-trip because this is OUR format, not a guess at markdown: the renderer
 *  emits `# title` then `## heading` blocks, so splitting on level-2 headings is its exact
 *  inverse. The `## Source files` block the renderer appends is dropped rather than
 *  returned as a section — `apply` re-adds it from the entry's own `sourceFiles`, and
 *  keeping it would duplicate the list on every re-render. */
export function parseSectionsFromMarkdown(markdown: string): KbSection[] {
  const sections: KbSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === null) return;
    if (heading.trim().toLowerCase() !== 'source files') {
      sections.push({ heading: heading.trim(), body: body.join('\n').trim() });
    }
    heading = null;
    body = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!;
      continue;
    }
    if (heading !== null) body.push(line);
  }
  flush();
  return sections;
}

export class KbBodyPathError extends Error {}

/** Resolve a declared body path to an absolute path inside the workspace.
 *
 *  Refused rather than repaired when it escapes: every legitimate producer can name a
 *  path without `..`, so its presence is a payload to reject, not one to clean up — the
 *  same stance the attachment rules take. An absolute path is refused for the same
 *  reason: the agent was told where to write. */
export function resolveKbBodyPath(repoPath: string, declared: string): string {
  if (declared.length === 0) throw new KbBodyPathError('bodyPath is empty');
  if (path.isAbsolute(declared))
    throw new KbBodyPathError(`bodyPath must be relative: ${declared}`);
  const abs = path.resolve(repoPath, declared);
  const root = path.resolve(repoPath, KB_DRAFT_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new KbBodyPathError(`bodyPath must sit under ${KB_DRAFT_DIR}: ${declared}`);
  }
  return abs;
}

/** Read one staged body and return its sections.
 *
 *  A declared-but-missing file THROWS instead of yielding an empty entry: the index said
 *  the agent wrote it, and publishing a blank page under a canonical KB name is worse
 *  than failing the entry — an empty ARCHITECTURE.md reads as "this project has no
 *  architecture" to every later reader, human and agent. */
export async function readKbBodyFile(repoPath: string, declared: string): Promise<KbSection[]> {
  const abs = resolveKbBodyPath(repoPath, declared);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    throw new KbBodyPathError(`bodyPath declared but not written: ${declared}`);
  }
  const sections = parseSectionsFromMarkdown(text);
  if (sections.length === 0) {
    throw new KbBodyPathError(`bodyPath has no \`## \` sections: ${declared}`);
  }
  return sections;
}

/** Anything carrying sections that may instead be staged in a file. */
export interface WithOptionalBodyPath {
  sections?: KbSection[];
  bodyPath?: string;
}

/** Fill `sections` from `bodyPath` where the payload staged them in a file.
 *
 *  Inline sections still win, so a model that ignores the new contract — or a
 *  `detect_output` replayed from before it existed — behaves exactly as it did. The
 *  whole point of the split is that the BODIES never travel through the response: an
 *  entire knowledge base in one fenced block hits the model's single-message ceiling,
 *  and MEASURED on a live repo that cost 4,083s and 378,008 output tokens to produce
 *  135,433 characters — 3.7x the tokens of the run before it for FEWER bytes, all of it
 *  spent shortening and re-emitting.
 *
 *  Reports failures instead of throwing: one unreadable body must not discard the
 *  fifteen entries beside it that are fine. */
export async function resolveBodies<T extends WithOptionalBodyPath>(
  repoPath: string,
  items: readonly T[],
): Promise<{ resolved: T[]; failures: { item: T; reason: string }[] }> {
  const resolved: T[] = [];
  const failures: { item: T; reason: string }[] = [];
  for (const item of items) {
    if (Array.isArray(item.sections) && item.sections.length > 0) {
      resolved.push(item);
      continue;
    }
    if (typeof item.bodyPath !== 'string' || item.bodyPath.length === 0) {
      failures.push({ item, reason: 'no sections and no bodyPath' });
      continue;
    }
    try {
      resolved.push({ ...item, sections: await readKbBodyFile(repoPath, item.bodyPath) });
    } catch (err) {
      failures.push({ item, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { resolved, failures };
}

/** Create a directory the SANDBOXED AGENT can write into.
 *
 *  The worker runs as root and the CLI sandbox runs as uid 1000, so a plain `mkdir` here
 *  produces a `root:root 0755` directory the agent cannot write — MEASURED, an 8-minute
 *  run wrote zero bodies into exactly that. The repo root is already chowned to the
 *  sandbox user (`chownRepoVolume`, see 01c-ddev-env), so this matches the PARENT's
 *  ownership rather than hardcoding 1000, which keeps it correct wherever that uid
 *  differs.
 *
 *  Best-effort: on a host where chown is not permitted the directory still exists, the
 *  agent falls back to inline sections, and the step behaves as it did before any of
 *  this — a degraded path, not a broken one. */
export async function prepareAgentWritableDir(
  repoPath: string,
  relDir: string,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const abs = path.resolve(repoPath, relDir);
  await mkdir(abs, { recursive: true });
  try {
    const owner = await stat(repoPath);
    // Every level we created, not just the leaf: `.haive/` is root-owned from earlier
    // steps and an unwritable parent defeats a writable child.
    for (const dir of ancestorsWithin(repoPath, abs)) await chown(dir, owner.uid, owner.gid);
  } catch (err) {
    logger?.warn({ err, relDir }, 'could not hand the draft dir to the sandbox user');
  }
}

/** Drop the staging dir once its bodies have been filed.
 *
 *  The drafts are scratch, and they are scratch INSIDE the repo: `.haive/` is not
 *  gitignored and `12-post-onboarding` stages `.haive/install.json` by name rather than
 *  the directory, so on an ordinary repo they sit in the user's `git status` for good —
 *  and on one onboarding has to `git init` itself (uploaded or blank) that step stages the
 *  WHOLE tree with `git add -A`, which commits every draft into the first commit.
 *
 *  Best-effort: a staging dir that will not delete is untidy, never a reason to fail a
 *  knowledge base that is already written. */
export async function discardKbDrafts(
  repoPath: string,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  try {
    await rm(path.resolve(repoPath, KB_DRAFT_DIR), { recursive: true, force: true });
  } catch (err) {
    logger?.warn({ err }, 'could not remove the kb draft dir');
  }
}

/** Every directory from `repoPath` (exclusive) down to `abs` (inclusive). */
function ancestorsWithin(repoPath: string, abs: string): string[] {
  const out: string[] = [];
  let cur = abs;
  const root = path.resolve(repoPath);
  while (cur !== root && cur.startsWith(root + path.sep)) {
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out.reverse();
}
