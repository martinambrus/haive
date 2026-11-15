import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseCommittedSnapshotRef,
  serializeCommittedSnapshotRef,
  parseCommittedSnapshotRefs,
} from '../src/committed-snapshot.js';

const ref = {
  version: 1,
  userId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
  taskId: '33333333-3333-4333-8333-333333333333',
  commitOid: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  inventoryId: '44444444-4444-4444-8444-444444444444',
  inventorySha256: 'c'.repeat(64),
};

describe('host-issued committed snapshot descriptor', () => {
  it('accepts generated owner ids and rejects non-RFC sentinel owners', () => {
    const owned = {
      ...ref,
      userId: randomUUID(),
      repositoryId: randomUUID(),
      taskId: randomUUID(),
    };
    expect(parseCommittedSnapshotRef(owned)).toEqual(owned);
    for (const key of ['userId', 'repositoryId', 'taskId'] as const) {
      expect(() =>
        parseCommittedSnapshotRef({ ...owned, [key]: '00000000-0000-0000-0000-000000000001' }),
      ).toThrow('Invalid committed snapshot');
    }
  });
  it('round trips strictly, without paths or mutable checkout names', () => {
    expect(parseCommittedSnapshotRef(JSON.parse(serializeCommittedSnapshotRef(ref)))).toEqual(ref);
    const sha256 = { ...ref, commitOid: 'd'.repeat(64), treeOid: 'e'.repeat(64) };
    expect(parseCommittedSnapshotRef(sha256)).toEqual(sha256);
  });
  it.each([
    null,
    {},
    { ...ref, version: 2 },
    { ...ref, hostPath: '/host/repo' },
    { ...ref, tracked: true },
    { ...ref, inventoryId: '../inventory' },
    { ...ref, commitOid: 'HEAD' },
    { ...ref, treeOid: 'a'.repeat(64) },
    { ...ref, inventorySha256: 'bad' },
    { ...ref, repositoryId: 'other' },
    { ...ref, treeOid: 'B'.repeat(40) },
  ])('rejects invalid or agent-supplied fields: %j', (value) => {
    expect(() => parseCommittedSnapshotRef(value)).toThrow('Invalid committed snapshot');
    expect(() => serializeCommittedSnapshotRef(value)).toThrow('Invalid committed snapshot');
  });
  it('accepts only target with optional base in the same ownership scope', () => {
    expect(parseCommittedSnapshotRefs({})).toEqual({ snapshotRef: null, baseSnapshotRef: null });
    expect(parseCommittedSnapshotRefs({ snapshotRef: ref })).toEqual({
      snapshotRef: ref,
      baseSnapshotRef: null,
    });
    expect(() => parseCommittedSnapshotRefs({ baseSnapshotRef: ref })).toThrow(
      'Invalid committed snapshot',
    );
    for (const field of ['userId', 'repositoryId', 'taskId']) {
      expect(() =>
        parseCommittedSnapshotRefs({
          snapshotRef: ref,
          baseSnapshotRef: { ...ref, [field]: '55555555-5555-4555-8555-555555555555' },
        }),
      ).toThrow('Invalid committed snapshot');
    }
    expect(
      parseCommittedSnapshotRefs({
        snapshotRef: ref,
        baseSnapshotRef: { ...ref, commitOid: 'f'.repeat(40) },
      }),
    ).toMatchObject({ snapshotRef: ref });
  });
});
