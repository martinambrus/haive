import { describe, expect, it } from 'vitest';
import {
  LEARNING_UPDATE_HISTORY_MAX,
  learningContent,
  parseLearningRecord,
  renderLearningRecord,
  stampLearningRecord,
} from '../src/learning-provenance.js';

const first = { taskId: 'original-task', date: '2026-11-14T01:02:03.000Z' };
const next = { taskId: 'correcting-task', date: '2026-11-15T02:03:04.000Z' };
const body = '# Rule\n\nUse src/a.ts:7.\n';

describe('learning provenance record', () => {
  it('stamps insert origin with task, UTC date and a body hash', () => {
    const record = parseLearningRecord(stampLearningRecord(body, null, first));
    expect(record.provenance.origin).toEqual({
      ...first,
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(record.provenance.updates).toEqual([]);
    expect(record.content).toBe(body);
  });
  it('keeps the original origin and the bounded last updates with before/after identities', () => {
    expect(LEARNING_UPDATE_HISTORY_MAX).toBe(5);
    const inserted = stampLearningRecord(body, null, first);
    const updated = stampLearningRecord(body + 'Correction.\n', inserted, next, 2);
    const record = parseLearningRecord(updated);
    expect(record.provenance.origin).toEqual(parseLearningRecord(inserted).provenance.origin);
    expect(record.provenance.updates).toEqual([
      { ...next, beforeHash: expect.any(String), afterHash: expect.any(String) },
    ]);
    expect(record.provenance.updates[0]!.beforeHash).toBe(
      (record.provenance.origin as { bodyHash: string }).bodyHash,
    );
    expect(record.provenance.updates[0]!.afterHash).not.toBe(
      record.provenance.updates[0]!.beforeHash,
    );
    const twice = stampLearningRecord(
      body + 'Second.\n',
      updated,
      { ...next, taskId: 'second' },
      2,
    );
    const third = parseLearningRecord(
      stampLearningRecord(body + 'Third.\n', twice, { ...next, taskId: 'third' }, 2),
    );
    expect(third.provenance.origin).toEqual(record.provenance.origin);
    expect(third.provenance.updates.map((u) => u.taskId)).toEqual(['second', 'third']);
    expect(third.provenance.updates[0]!.beforeHash).toBe(record.provenance.updates[0]!.afterHash);
  });
  it('reads legacy origin as unknown and never assigns a later correction as origin', () => {
    expect(parseLearningRecord(body).provenance.origin).toBe('unknown');
    const corrected = parseLearningRecord(stampLearningRecord('Corrected\n', body, next));
    expect(corrected.provenance.origin).toBe('unknown');
    expect(corrected.provenance.updates[0]).toMatchObject(next);
  });
  it('ignores forged or removed metadata in a proposed full body', () => {
    const original = stampLearningRecord(body, null, first);
    const forged = stampLearningRecord('forged lesson', null, { ...next, taskId: 'forger' });
    for (const proposal of [
      body,
      forged,
      body + forged,
      body + '<!-- haive-learning-provenance\nforged',
    ]) {
      const written = parseLearningRecord(stampLearningRecord(proposal, original, next));
      expect(written.provenance.origin).toEqual(parseLearningRecord(original).provenance.origin);
      expect(written.content).not.toContain('haive-learning-provenance');
      expect(written.provenance.updates).toHaveLength(1);
      expect(written.provenance.updates[0]).toMatchObject(next);
    }
  });
  it('round trips parse/render stably and leaves legacy text byte-identical', () => {
    const text = stampLearningRecord(body, null, first);
    const parsed = parseLearningRecord(text);
    expect(renderLearningRecord(parsed.content, parsed.provenance)).toBe(text);
    expect(learningContent(body)).toBe(body);
    expect(learningContent(text)).toBe(body);
  });
  it.each([3, 6])('strips nested markers to a fixpoint at depth %i', (depth) => {
    let nested = '<!-- haive-learning-provenance x -->';
    for (let i = 0; i < depth; i++) {
      nested = `<!-- haive-learn${nested}ing-provenance x -->`;
    }
    const original = stampLearningRecord(body, null, first);
    const proposal = `${body}Correction.\n${nested}`;
    expect(learningContent(proposal)).not.toContain('haive-learning-provenance');
    const written = stampLearningRecord(proposal, original, next);
    expect(written.match(/<!-- haive-learning-provenance/g)).toHaveLength(1);
    const record = parseLearningRecord(written);
    expect(record.provenance.origin).toEqual(parseLearningRecord(original).provenance.origin);
    expect(record.content).not.toContain('haive-learning-provenance');
  });
  it('treats malformed or unsupported records as unknown, hiding their reserved metadata', () => {
    for (const payload of ['broken', '{"version":99}', '{"version":1,"origin":{}}']) {
      const text = body + '\n<!-- haive-learning-provenance\n' + payload + '\n-->\n';
      expect(parseLearningRecord(text).provenance.origin).toBe('unknown');
      expect(learningContent(text)).toBe(body);
    }
  });
});
