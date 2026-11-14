import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stampLearningRecord } from '@haive/shared/learning-provenance';
import path from 'node:path';
import {
  applyLearningOps,
  applyStagedLearningEdits,
  learningIndex,
  planLearningReconciliation,
  readExistingLearnings,
  stageLearningDrafts,
} from './11-phase-8-learning.js';
import { extractMarkdownSections, chunkSection } from '../onboarding/_rag-chunkers.js';

const origin = { taskId: 'original-task', date: '2026-11-14T01:02:03.000Z' };
const update = { taskId: 'correcting-task', date: '2026-11-15T01:02:03.000Z' };
let worktree: string;
afterEach(async () => {
  if (worktree) await rm(worktree, { recursive: true, force: true });
});
const entry = (body = 'Use src/a.ts:7.') => ({
  id: 'rule',
  title: 'Rule',
  body,
  op: 'insert' as const,
});
const metadata = (text: string) => {
  const json = text.split('<!-- haive-learning-provenance\n')[1]?.split('\n-->')[0];
  return json ? JSON.parse(json) : null;
};

describe('learning provenance through workflow readers and writer', () => {
  it('stamps the actual insert and retains origin through an inline edited full-body update', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    await applyLearningOps(worktree, planLearningReconciliation([entry()], []), undefined, origin);
    const file = path.join(worktree, '.haive-data/learnings/rule.md');
    const inserted = await readFile(file, 'utf8');
    expect(metadata(inserted)?.origin).toMatchObject(origin);
    const existing = await readExistingLearnings(worktree);
    const plan = planLearningReconciliation(
      [{ ...entry('Correct src/a.ts:9.'), op: 'update', targetId: 'rule' }],
      existing,
    );
    await stageLearningDrafts(worktree, plan, null);
    // The reviewer can replace the whole body, omitting all prior metadata.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(worktree, '.haive/learning-drafts/learnings/rule.md'),
      '# Rule\n\nHuman correction src/a.ts:10.',
    );
    const edited = await applyStagedLearningEdits(worktree, plan);
    await applyLearningOps(worktree, edited, undefined, update);
    const written = await readFile(file, 'utf8');
    expect(metadata(written)?.origin).toEqual(metadata(inserted)?.origin);
    expect(metadata(written)?.updates).toEqual([
      { ...update, beforeHash: expect.any(String), afterHash: expect.any(String) },
    ]);
    expect(written).toContain('Human correction');
  });
  it('keeps metadata out of the excerpt and indexed/embedded chunks even for a short learning', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    await applyLearningOps(worktree, planLearningReconciliation([entry()], []), undefined, origin);
    const existing = await readExistingLearnings(worktree);
    expect(existing[0]!.body).toContain('haive-learning-provenance');
    expect(learningIndex(existing).entries[0]!.excerpt).toBe('Use src/a.ts:7.');
    const sections = extractMarkdownSections(existing[0]!.body, '.haive-data/learnings/rule.md');
    const chunks = sections.flatMap((s) => chunkSection(s));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content).toContain('Use src/a.ts:7.');
      expect(chunk.content).not.toContain(origin.taskId);
      expect(chunk.content).not.toContain(origin.date);
      expect(chunk.content).not.toContain('haive-learning-provenance');
    }
  });
});

describe('learning provenance reader boundaries', () => {
  const prose = '# Rule\n\nUse src/a.ts:7.\n';
  const stored = () => stampLearningRecord(prose, null, origin);
  it('excludes provenance from the short excerpt listed to the agent', () => {
    const result = learningIndex([{ id: 'rule', title: 'Rule', body: stored() }]);
    expect(result.entries).toEqual([{ id: 'rule', title: 'Rule', excerpt: 'Use src/a.ts:7.' }]);
  });
  it('indexes exactly the original text and chunk hashes before embedding in either ingestion path', () => {
    const chunks = (text: string) =>
      extractMarkdownSections(text, '.haive-data/learnings/rule.md').flatMap((s) =>
        chunkSection(s),
      );
    expect(chunks(stored())).toEqual(chunks(prose));
  });
  it('shows provenance in the existing human diff while ignoring metadata-only staged edits in counts', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    const plan = planLearningReconciliation([entry()], [], undefined, undefined, origin);
    expect(metadata(plan[0]!.newBody)?.origin).toMatchObject(origin);
    await stageLearningDrafts(worktree, plan, null);
    const counts = { removed: 0, edited: 0, excluded: 0 };
    await applyStagedLearningEdits(worktree, planLearningReconciliation([entry()], []), counts);
    expect(counts).toEqual({ removed: 0, edited: 0, excluded: 0 });
  });
  it('neutralises forged metadata in an agent body before staging and keeps the trusted prior origin', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    const forged = stampLearningRecord('Correct src/a.ts:9.', null, {
      ...update,
      taskId: 'forger',
    });
    const existing = [{ id: 'rule', title: 'Rule', body: stored() }];
    const plan = planLearningReconciliation(
      [{ ...entry(forged), op: 'update', targetId: 'rule' }],
      existing,
    );
    expect(plan[0]!.newBody).not.toContain('forger');
    await applyLearningOps(worktree, plan, undefined, update);
    const written = await readFile(path.join(worktree, '.haive-data/learnings/rule.md'), 'utf8');
    expect(metadata(written)?.origin).toEqual(metadata(stored())?.origin);
    expect(written).not.toContain('forger');
  });
});

describe('provenance preserves write and review semantics', () => {
  it('chains every update of the same target within one apply', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    const initial = stampLearningRecord('# Rule\n\nUse src/a.ts:7.', null, origin);
    const existing = [{ id: 'rule', title: 'Rule', body: initial }];
    const entries = ['First src/a.ts:8.', 'Second src/a.ts:9.'].map((body) => ({
      ...entry(body),
      op: 'update' as const,
      targetId: 'rule',
    }));
    const plan = planLearningReconciliation(entries, existing);
    await applyLearningOps(worktree, plan, undefined, update);
    const written = await readFile(path.join(worktree, '.haive-data/learnings/rule.md'), 'utf8');
    const record = metadata(written);
    expect(record.updates).toHaveLength(2);
    expect(record.updates[1].beforeHash).toBe(record.updates[0].afterHash);
    expect(record.origin).toEqual(metadata(initial).origin);
  });
  it('honors a cleared staged body even when its provenance footer remains', async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'learning-provenance-'));
    const plan = planLearningReconciliation([entry()], [], undefined, undefined, origin);
    await stageLearningDrafts(worktree, plan, null);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(worktree, '.haive/learning-drafts/learnings/rule.md'),
      stampLearningRecord('', null, origin),
    );
    const counts = { removed: 0, edited: 0, excluded: 0 };
    expect(await applyStagedLearningEdits(worktree, plan, counts)).toEqual([]);
    expect(counts).toEqual({ removed: 1, edited: 0, excluded: 0 });
  });
});
