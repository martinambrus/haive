import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { serializeReviewPayload, type ReviewSnapshot } from '../src/step-engine/review-diff.js';
const snapshot: ReviewSnapshot = {
  forkPoint: 'abc',
  changeHash: 'all-changes',
  scope: { files: ['a', 'b'], total: 3, truncated: true, scanError: null },
  dependencyPolicy: {},
  reviewDimensions: ['security'],
  diff: 'diff a\n+new\n',
  files: [
    { path: 'a', kind: 'text', mode: 420, size: 4, hash: 'hash-a', content: 'new\n' },
    { path: 'b', kind: 'binary', mode: 420, size: 1, hash: 'hash-b' },
  ],
};
it('canonicalizes scope and policy and hashes the exact payload including the flag', () => {
  const a = serializeReviewPayload(snapshot, { maxBytes: 10000 });
  const b = serializeReviewPayload(
    { ...snapshot, scope: { ...snapshot.scope, files: ['b', 'a'] } },
    { maxBytes: 10000 },
  );
  expect(a).toEqual(b);
  expect(a.status).toBe('ready');
  if (a.status !== 'ready') throw Error('not ready');
  expect(a.bytes).toBe(Buffer.byteLength(a.content));
  expect(a.diffHash).toBe(createHash('sha256').update(a.content).digest('hex'));
  expect(JSON.parse(a.content).coverage).toMatchObject({ partial: true });
  const flagged = serializeReviewPayload(snapshot, { maxBytes: 10000, includeFileContents: true });
  expect(flagged.status === 'ready' && flagged.diffHash).not.toBe(a.diffHash);
  const changed = serializeReviewPayload(
    { ...snapshot, files: snapshot.files.map((f) => ({ ...f, hash: 'changed' })) },
    { maxBytes: 10000 },
  );
  expect(changed.status === 'ready' && changed.diffHash).not.toBe(a.diffHash);
});
it('includes post-change text after the diff, and discloses binary contents', () => {
  const r = serializeReviewPayload(snapshot, { maxBytes: 10000, includeFileContents: true });
  expect(r.status).toBe('ready');
  if (r.status !== 'ready') return;
  const payload = JSON.parse(r.content);
  expect(payload.fileContents).toEqual([{ path: 'a', content: 'new\n' }]);
  expect(payload.omittedContents).toEqual([{ path: 'b', reason: 'binary' }]);
  expect(r.content.indexOf('diff')).toBeLessThan(r.content.indexOf('fileContents'));
});
it('includes text files that fit in path order and discloses budget omissions', () => {
  const data = {
    ...snapshot,
    files: [
      {
        path: 'a',
        kind: 'text' as const,
        mode: 420,
        size: 2000,
        hash: 'a',
        content: 'x'.repeat(2000),
      },
      { path: 'b', kind: 'text' as const, mode: 420, size: 1, hash: 'b', content: 'y' },
    ],
  };
  const r = serializeReviewPayload(data, { maxBytes: 1500, includeFileContents: true });
  expect(r.status).toBe('ready');
  if (r.status !== 'ready') return;
  expect(r.bytes).toBeLessThanOrEqual(1500);
  expect(JSON.parse(r.content).fileContents).toEqual([{ path: 'b', content: 'y' }]);
  expect(JSON.parse(r.content).omittedContents).toContainEqual({ path: 'a', reason: 'maxBytes' });
});
it('refuses a diff alone over budget and never approves empty scope', () => {
  expect(
    serializeReviewPayload(
      { ...snapshot, diff: 'x'.repeat(100) },
      { maxBytes: 10, includeFileContents: true },
    ).status,
  ).toBe('too-large');
  expect(
    serializeReviewPayload(
      { ...snapshot, scope: { files: [], total: 0, truncated: false } },
      { maxBytes: 10000 },
    ).status,
  ).toBe('unavailable');
});
