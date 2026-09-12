import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KB_DIR,
  LEARNINGS_DIR,
  LEGACY_KB_DIR,
  LEGACY_LEARNINGS_DIR,
} from '@haive/shared/knowledge-paths';
import { migrateLegacyKnowledge } from '../src/step-engine/steps/onboarding/_kb-legacy.js';
import { sanitizeKbRelPath } from '../src/step-engine/steps/onboarding/_kb-write.js';

// Onboarding's reuse path was written for a KB "copied in from a prior orchestration" and
// found one for free while KB_DIR was `.claude/knowledge_base`. The move to `.haive-data/`
// declared such trees "simply ignored" because all data then was demo data — false for any
// project carrying real knowledge from the legacy workflow. MEASURED on one: 41 tracked
// files committed months earlier, invisible to every reader afterwards.
describe('migrateLegacyKnowledge', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kblegacy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(rel: string, body: string): Promise<void> {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }

  it('moves a legacy KB into the canonical dir, subdirectories included', async () => {
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Architecture\n');
    await write(`${LEGACY_KB_DIR}/TECH_PATTERNS/drupal7/INDEX.md`, '# D7\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved.sort()).toEqual(
      [`${KB_DIR}/ARCHITECTURE.md`, `${KB_DIR}/TECH_PATTERNS/drupal7/INDEX.md`].sort(),
    );
    expect(r.skipped).toEqual([]);
    expect(await readFile(path.join(dir, KB_DIR, 'ARCHITECTURE.md'), 'utf8')).toContain(
      'Architecture',
    );
    // A MOVE: two knowledge bases in one repo is worse than either, because the RAG
    // collectors key on the canonical prefixes and would index one while a human reads
    // the other.
    await expect(stat(path.join(dir, LEGACY_KB_DIR))).rejects.toThrow();
  });

  it('migrates learnings by the same rule', async () => {
    await write(`${LEGACY_LEARNINGS_DIR}/2026-01-lesson.md`, '# Lesson\n');
    const r = await migrateLegacyKnowledge(dir);
    expect(r.moved).toEqual([`${LEARNINGS_DIR}/2026-01-lesson.md`]);
  });

  // Canonical content is the newer claim — 08 may have just generated it. MEASURED on a
  // repo onboarded after the move, 7 of its 41 legacy filenames collide with fresh ones.
  it('never overwrites a taken canonical slot, and says what it left', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Fresh canonical\n');
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Stale legacy\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved).toEqual([]);
    expect(r.skipped).toEqual([`${LEGACY_KB_DIR}/ARCHITECTURE.md`]);
    expect(await readFile(path.join(dir, KB_DIR, 'ARCHITECTURE.md'), 'utf8')).toContain('Fresh');
    // The skipped file keeps its directory rather than being silently destroyed.
    expect(await readFile(path.join(dir, LEGACY_KB_DIR, 'ARCHITECTURE.md'), 'utf8')).toContain(
      'Stale',
    );
  });

  it('moves what it can when one name collides', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Fresh\n');
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Stale\n');
    await write(`${LEGACY_KB_DIR}/BUSINESS_LOGIC.md`, '# Logic\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved).toEqual([`${KB_DIR}/BUSINESS_LOGIC.md`]);
    expect(r.skipped).toEqual([`${LEGACY_KB_DIR}/ARCHITECTURE.md`]);
  });

  it('is a no-op and idempotent on a repo with no legacy tree', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Only canonical\n');
    expect(await migrateLegacyKnowledge(dir)).toEqual({ moved: [], skipped: [] });
    expect(await migrateLegacyKnowledge(dir)).toEqual({ moved: [], skipped: [] });
  });
});

// A model names the path it SAW, and a repo whose knowledge predates the move still shows
// that tree — MEASURED, one run reported all 41 of its files under `.claude/knowledge_base/`.
// The move's own commit predicted such a path would "get a nested directory rather than an
// error"; stripping both roots is what makes the lookup agree with the scan.
describe('sanitizeKbRelPath strips either knowledge-base root', () => {
  it('normalises the legacy root', () => {
    const r = sanitizeKbRelPath(`${LEGACY_KB_DIR}/ARCHITECTURE.md`);
    expect(r).toEqual({ ok: true, normalized: 'ARCHITECTURE.md' });
  });

  it('still normalises the canonical root', () => {
    const r = sanitizeKbRelPath(`${KB_DIR}/ANTI_PATTERNS/x.md`);
    expect(r).toEqual({ ok: true, normalized: 'ANTI_PATTERNS/x.md' });
  });

  it('leaves an already-relative path alone', () => {
    expect(sanitizeKbRelPath('ARCHITECTURE.md')).toEqual({
      ok: true,
      normalized: 'ARCHITECTURE.md',
    });
  });

  it('still refuses traversal and absolute paths', () => {
    expect(sanitizeKbRelPath(`${LEGACY_KB_DIR}/../../etc/passwd`).ok).toBe(false);
    expect(sanitizeKbRelPath('/etc/passwd').ok).toBe(false);
  });
});
