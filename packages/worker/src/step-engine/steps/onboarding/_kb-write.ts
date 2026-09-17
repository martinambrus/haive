import path from 'node:path';
import { isPathContainmentError, updateFileNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR, LEGACY_KB_DIR } from '@haive/shared/knowledge-paths';

/* ------------------------------------------------------------------ */
/* Knowledge-base write helpers                                        */
/*                                                                     */
/* Shared by the Q&A steps: 09_2-qa-resolve gathers proposed writes    */
/* (without applying them) and 09_3-qa-review applies the confirmed    */
/* ones after the human review gate. Append-only by design — see       */
/* appendSection.                                                       */
/* ------------------------------------------------------------------ */

export interface KbWrite {
  /** Path relative to the knowledge-base root (`KB_DIR`). Sanitized in apply. */
  relPath: string;
  section: string;
  content: string;
}

/** Escape EVERY regex metacharacter, backslash included, so a path means only itself.
 *
 *  Hand-escaping just the dot is what the single-root version did, and it was incomplete in
 *  a way no current input reaches — these constants hold only alphanumerics, `.`, `-`, `_`
 *  and `/`. Incomplete anyway: a backslash in the input would have survived into the pattern
 *  as an escape character and changed what the next character meant. `/` is deliberately NOT
 *  escaped here, because the caller turns it into a separator class after this runs. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a leading knowledge-base root written with either separator. Derived from the
 *  constants so the pattern cannot drift from the paths it strips: every metacharacter is
 *  escaped, then each `/` becomes a separator class.
 *
 *  The LEGACY root is stripped too. A model names a path it saw on disk, and a repo whose
 *  knowledge predates `.haive-data/` has that tree right there — MEASURED, one run reported
 *  all 41 of its files under `.claude/knowledge_base/`. Stripping only the new root left
 *  those unmatched, which the move's own commit predicted would "get a nested directory
 *  rather than an error". */
const KB_ROOT_PREFIX_RE = new RegExp(
  `^(?:${[KB_DIR, LEGACY_KB_DIR]
    .map((d) => escapeRegexLiteral(d).replace(/\//g, '[/\\\\]'))
    .join('|')})[/\\\\]`,
);

export interface SafeRelPath {
  ok: true;
  normalized: string;
}
export interface UnsafeRelPath {
  ok: false;
  reason: string;
}
export type RelPathCheck = SafeRelPath | UnsafeRelPath;

/** Reject paths that escape the KB dir or contain unsafe segments. */
export function sanitizeKbRelPath(rel: string): RelPathCheck {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, reason: 'empty path' };
  }
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    return { ok: false, reason: 'absolute path not allowed' };
  }
  // Strip a leading knowledge-base root if the LLM included it.
  let normalized = rel.replace(KB_ROOT_PREFIX_RE, '');
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty after stripping KB prefix' };
  }
  const parts = normalized.split(/[\\/]/);
  if (parts.some((p) => p === '..' || p === '.')) {
    return { ok: false, reason: '"." or ".." segment not allowed' };
  }
  if (!normalized.endsWith('.md')) normalized += '.md';
  return { ok: true, normalized };
}

function appendSection(
  existing: string,
  section: string,
  content: string,
  isoStamp: string,
): string {
  const trimmedExisting = existing.endsWith('\n') ? existing : `${existing}\n`;
  const day = isoStamp.slice(0, 10);
  return [
    trimmedExisting.trimEnd(),
    '',
    `## ${section} (added ${day})`,
    '',
    content.trim(),
    '',
  ].join('\n');
}

export async function applyKbWrites(
  repoRoot: string,
  writes: KbWrite[],
  nowIso: string,
): Promise<{
  written: { relPath: string; section: string }[];
  skipped: { relPath: string; reason: string }[];
}> {
  const written: { relPath: string; section: string }[] = [];
  const skipped: { relPath: string; reason: string }[] = [];

  for (const write of writes) {
    const check = sanitizeKbRelPath(write.relPath);
    if (!check.ok) {
      skipped.push({ relPath: write.relPath, reason: check.reason });
      continue;
    }
    // One descriptor for the probe, the read AND the write, where there were four path
    // resolutions. `pathExists` is `stat`-based, so it followed a link and read a DANGLING one as
    // absent — the probe then said "new file" and the write landed on whatever the link named.
    //
    // `sanitizeKbRelPath` above still gates the path and is not replaced by `toSafeRel`: it reports
    // a bad entry as `skipped` and the loop carries on, where the primitive throws. That is the
    // difference between dropping one proposed write and failing the whole step.
    //
    // An existing file that cannot be READ now throws rather than being treated as empty. That is
    // the intended direction: silently overwriting a file we could not read is worse than failing.
    try {
      await updateFileNoFollow(
        repoRoot,
        `${KB_DIR}/${check.normalized}`,
        (existing) =>
          existing === null || existing.length === 0
            ? `# ${check.normalized.replace(/\.md$/, '').replace(/[/\\]/g, ' / ')}\n\n## ${write.section} (added ${nowIso.slice(0, 10)})\n\n${write.content.trim()}\n`
            : appendSection(existing, write.section, write.content, nowIso),
        { create: true, createParents: true },
      );
    } catch (err) {
      // A refused target joins the `skipped` list rather than aborting the loop: this function
      // already treats one bad path as a per-item outcome, and a link is the same class of problem.
      // Anything else is a real failure and propagates.
      if (!isPathContainmentError(err)) throw err;
      skipped.push({ relPath: write.relPath, reason: `refused: ${err.reason}` });
      continue;
    }
    written.push({ relPath: path.join(KB_DIR, check.normalized), section: write.section });
  }
  return { written, skipped };
}
