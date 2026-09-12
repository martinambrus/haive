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
import {
  LEGACY_IMPORT_SUBDIR,
  migrateLegacyKnowledge,
} from '../src/step-engine/steps/onboarding/_kb-legacy.js';
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
    expect(r.pendingMerge).toEqual([]);
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

  // The collision topics are the ones with the MOST history behind them — months of
  // task-by-task syncs against one agent's fresh read. Keeping only the newer page loses the
  // wrong half, so the legacy copy is imported where the reuse prompt can see both.
  it('imports a colliding file under legacy/ instead of overwriting or abandoning it', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Fresh canonical\n');
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Accumulated legacy\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved).toEqual([]);
    expect(r.pendingMerge).toEqual([`${KB_DIR}/${LEGACY_IMPORT_SUBDIR}/ARCHITECTURE.md`]);
    expect(r.skipped).toEqual([]);
    // The newer page is untouched...
    expect(await readFile(path.join(dir, KB_DIR, 'ARCHITECTURE.md'), 'utf8')).toContain('Fresh');
    // ...and the accumulated one is inside the KB, where scanExistingKb recurses to it.
    expect(
      await readFile(path.join(dir, KB_DIR, LEGACY_IMPORT_SUBDIR, 'ARCHITECTURE.md'), 'utf8'),
    ).toContain('Accumulated');
    // Nothing stranded outside the knowledge base.
    await expect(stat(path.join(dir, LEGACY_KB_DIR))).rejects.toThrow();
  });

  it('mixes straight moves and legacy imports in one pass', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Fresh\n');
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Stale\n');
    await write(`${LEGACY_KB_DIR}/BUSINESS_LOGIC.md`, '# Logic\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved).toEqual([`${KB_DIR}/BUSINESS_LOGIC.md`]);
    expect(r.pendingMerge).toEqual([`${KB_DIR}/${LEGACY_IMPORT_SUBDIR}/ARCHITECTURE.md`]);
  });

  // 08 rewrites the root index from whatever the KB ends up holding, so importing a stale
  // copy would publish a generated artifact as knowledge.
  it('leaves a colliding root INDEX.md alone rather than importing it', async () => {
    await write(`${KB_DIR}/INDEX.md`, '# Generated index\n');
    await write(`${LEGACY_KB_DIR}/INDEX.md`, '# Old index\n');

    const r = await migrateLegacyKnowledge(dir);

    expect(r.moved).toEqual([]);
    expect(r.pendingMerge).toEqual([]);
    expect(r.skipped).toEqual([`${LEGACY_KB_DIR}/INDEX.md`]);
    expect(await readFile(path.join(dir, KB_DIR, 'INDEX.md'), 'utf8')).toContain('Generated');
  });

  it('does not re-import on a second pass', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Fresh\n');
    await write(`${LEGACY_KB_DIR}/ARCHITECTURE.md`, '# Stale\n');
    const first = await migrateLegacyKnowledge(dir);
    expect(first.pendingMerge).toHaveLength(1);

    // The legacy tree is gone, so a re-run finds nothing to do at all.
    const second = await migrateLegacyKnowledge(dir);
    expect(second).toEqual({ moved: [], pendingMerge: [], skipped: [] });
  });

  it('is a no-op and idempotent on a repo with no legacy tree', async () => {
    await write(`${KB_DIR}/ARCHITECTURE.md`, '# Only canonical\n');
    expect(await migrateLegacyKnowledge(dir)).toEqual({ moved: [], pendingMerge: [], skipped: [] });
    expect(await migrateLegacyKnowledge(dir)).toEqual({ moved: [], pendingMerge: [], skipped: [] });
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
