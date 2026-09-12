import { chown, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
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

/** Resolve a declared body path to a file that is REALLY inside the draft dir.
 *
 *  `resolveKbBodyPath` is lexical, and lexical is not enough: the sandboxed agent owns this
 *  directory and can drop a symlink in it. The worker runs as ROOT, so following one reads a
 *  file the agent could never open itself and publishes it as trusted KB output — VERIFIED by
 *  a reviewer's reproduction, which returned the contents of an external mode-0600 file
 *  through these readers.
 *
 *  `realpath` collapses every link in the chain — the final component AND any intermediate
 *  directory — and the result is re-tested against the REAL draft root, so a link is refused
 *  wherever it sits. The regular-file check then rejects a fifo or device, which would hang or
 *  misread rather than escape. TOCTOU is not a live concern here: the CLI has exited by the
 *  time apply reads these, and nothing else writes the directory. */
/** How much clock slop to forgive when deciding a body predates its run.
 *
 *  The invocation's `started_at` comes from the worker's clock and the mtime from the
 *  filesystem's; both are the same host here, so the gap should be zero. A false REJECTION
 *  discards a body the agent really did write, which is the worse direction to be wrong in,
 *  so a couple of seconds are forgiven. Negligible against the minutes-long gap that an
 *  actual stale body carries. */
const STALE_BODY_GRACE_MS = 2_000;

async function resolveStagedFile(
  repoPath: string,
  declared: string,
  notBefore?: Date,
): Promise<string> {
  const lexical = resolveKbBodyPath(repoPath, declared);
  let real: string;
  let root: string;
  try {
    real = await realpath(lexical);
    root = await realpath(path.resolve(repoPath, KB_DRAFT_DIR));
  } catch {
    throw new KbBodyPathError(`bodyPath declared but not written: ${declared}`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new KbBodyPathError(`bodyPath resolves outside ${KB_DRAFT_DIR}: ${declared}`);
  }
  const st = await lstat(real);
  if (!st.isFile()) throw new KbBodyPathError(`bodyPath is not a regular file: ${declared}`);
  // A body older than the run that declared it is not that run's work. Body paths are
  // deterministic, so an attempt that declares a path and fails to write it would otherwise
  // publish whatever an EARLIER attempt left at the same name. `prepareAgentWritableDir`
  // empties the directory per attempt and closes that for a RETRY, where detect re-runs — but
  // an invocation orphaned by a worker restart is RE-DISPATCHED without detect, so the killed
  // run's bodies survive. MEASURED: 14 of them did, and only the agent happening to rewrite
  // every path it declared kept stale content out of the knowledge base.
  if (notBefore && st.mtimeMs < notBefore.getTime() - STALE_BODY_GRACE_MS) {
    throw new KbBodyPathError(
      `bodyPath predates this run — left by an earlier attempt: ${declared}`,
    );
  }
  return real;
}

/** Read one staged body and return its sections.
 *
 *  A declared-but-missing file THROWS instead of yielding an empty entry: the index said
 *  the agent wrote it, and publishing a blank page under a canonical KB name is worse
 *  than failing the entry — an empty ARCHITECTURE.md reads as "this project has no
 *  architecture" to every later reader, human and agent. */
export async function readKbBodyFile(
  repoPath: string,
  declared: string,
  notBefore?: Date,
): Promise<KbSection[]> {
  const abs = await resolveStagedFile(repoPath, declared, notBefore);
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

/** Read one staged body as RAW TEXT.
 *
 *  The sibling of `readKbBodyFile` for a consumer that wants the markdown as written
 *  rather than split into sections: 09_2 proposes ONE section per answer, so its body is
 *  already the content under a single heading and parsing it into sections would discard
 *  the shape the reviewer is about to approve.
 *
 *  Empty is a failure for the same reason a missing file is: the index said the agent
 *  wrote it, and an approved-but-blank KB section is worse than one that never arrived. */
export async function readKbBodyText(
  repoPath: string,
  declared: string,
  notBefore?: Date,
): Promise<string> {
  const abs = await resolveStagedFile(repoPath, declared, notBefore);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    throw new KbBodyPathError(`contentPath declared but not written: ${declared}`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new KbBodyPathError(`contentPath is empty: ${declared}`);
  return trimmed;
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
  notBefore?: Date,
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
      resolved.push({
        ...item,
        sections: await readKbBodyFile(repoPath, item.bodyPath, notBefore),
      });
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
  // EMPTY it first. Body paths are deterministic (`<id>.md`), so a retry that declares a path
  // and then fails to write it would otherwise read the PREVIOUS attempt's file and publish it
  // as this attempt's trusted output — VERIFIED by a reviewer's reproduction, where a retry
  // that wrote nothing published the prior attempt's body. Clearing here rather than only
  // after a successful apply is what makes every attempt start from nothing; it also discards
  // drafts a failed run left for diagnosis, which is the right trade — by the time anyone
  // retries, they have looked.
  await rm(abs, { recursive: true, force: true });
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
