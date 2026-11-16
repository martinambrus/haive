import { expect, it } from 'vitest';
import { readInsightBatchRecord } from '../src/step-engine/steps/workflow/_insight-batch.js';

const record = {
  version: 1,
  protocolVersion: 1,
  mode: 'gate3',
  batchId: 'batch',
  sourceStepRowId: 'source',
  generation: 0,
  stage: 'outcome',
  selected: [],
  items: [],
  notes: '',
  miningId: null,
  invocationId: null,
};
it('drops legacy maps and refuses their old writer-local equality evidence on replay', () => {
  const legacy = { ...record, worktreeBefore: { 'a.ts': 'stamp' }, worktreeUnchanged: true };
  const parsed = readInsightBatchRecord(legacy);
  expect(parsed).not.toHaveProperty('worktreeBefore');
  expect(parsed.worktreeUnchanged).toBe(false);
  expect(legacy.worktreeBefore).toEqual({ 'a.ts': 'stamp' });
});
it('accepts only fixed-size digests and retains the incomplete flag', () => {
  const worktreeBeforeDigest = { sha256: 'a'.repeat(64), incomplete: false };
  expect(readInsightBatchRecord({ ...record, worktreeBeforeDigest })).toMatchObject({
    worktreeBeforeDigest,
  });
  expect(
    readInsightBatchRecord({ ...record, worktreeBeforeDigest: { sha256: null, incomplete: true } }),
  ).toMatchObject({ worktreeBeforeDigest: { sha256: null, incomplete: true } });
  expect(() =>
    readInsightBatchRecord({
      ...record,
      worktreeBeforeDigest: { sha256: 'a'.repeat(65), incomplete: false },
    }),
  ).toThrow();
});
