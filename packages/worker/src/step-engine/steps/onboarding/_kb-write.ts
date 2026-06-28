import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './_helpers.js';

/* ------------------------------------------------------------------ */
/* Knowledge-base write helpers                                        */
/*                                                                     */
/* Shared by the Q&A steps: 09_2-qa-resolve gathers proposed writes    */
/* (without applying them) and 09_3-qa-review applies the confirmed    */
/* ones after the human review gate. Append-only by design — see       */
/* appendSection.                                                       */
/* ------------------------------------------------------------------ */

export const KB_ROOT = path.join('.claude', 'knowledge_base');

export interface KbWrite {
  /** Path relative to `.claude/knowledge_base/`. Sanitized in apply. */
  relPath: string;
  section: string;
  content: string;
}

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
  // Strip a leading `.claude/knowledge_base/` if the LLM included it.
  let normalized = rel.replace(/^\.claude[/\\]knowledge_base[/\\]/, '');
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
  const kbDir = path.join(repoRoot, KB_ROOT);

  for (const write of writes) {
    const check = sanitizeKbRelPath(write.relPath);
    if (!check.ok) {
      skipped.push({ relPath: write.relPath, reason: check.reason });
      continue;
    }
    const fullPath = path.join(kbDir, check.normalized);
    const dir = path.dirname(fullPath);
    await mkdir(dir, { recursive: true });
    let existing = '';
    if (await pathExists(fullPath)) {
      try {
        existing = await readFile(fullPath, 'utf8');
      } catch {
        existing = '';
      }
    }
    const next =
      existing.length === 0
        ? `# ${check.normalized.replace(/\.md$/, '').replace(/[/\\]/g, ' / ')}\n\n## ${write.section} (added ${nowIso.slice(0, 10)})\n\n${write.content.trim()}\n`
        : appendSection(existing, write.section, write.content, nowIso);
    await writeFile(fullPath, next, 'utf8');
    written.push({ relPath: path.join(KB_ROOT, check.normalized), section: write.section });
  }
  return { written, skipped };
}
