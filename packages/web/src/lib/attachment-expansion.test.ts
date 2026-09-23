import { describe, expect, it } from 'vitest';
import type { TaskAttachment } from './api-client';
import { awaitingExpansion, pollForExpansion } from './attachment-expansion';

const row = (filename: string, over: Partial<TaskAttachment> = {}): TaskAttachment => ({
  id: 'a',
  taskId: 't',
  filename,
  sizeBytes: 1,
  contentType: null,
  description: null,
  createdAt: '2026-09-23T12:00:00.000Z',
  expandedAt: null,
  expansionNote: null,
  expandedFromId: null,
  ...over,
});

describe('awaitingExpansion', () => {
  it('waits for an archive the worker has not expanded yet', () => {
    for (const name of ['spec.zip', 'docs/spec.tar.gz', 'SPEC.TGZ', 'spec.tar']) {
      expect(awaitingExpansion(row(name))).toBe(true);
    }
  });

  it('stops once the archive is stamped, whatever the expansion produced', () => {
    expect(awaitingExpansion(row('spec.zip', { expandedAt: '2026-09-23T12:00:05.000Z' }))).toBe(
      false,
    );
  });

  it('never waits for a file that is not an archive', () => {
    expect(awaitingExpansion(row('spec.md'))).toBe(false);
  });

  it('never waits for an archive that came out of another, which is never expanded', () => {
    expect(awaitingExpansion(row('spec/inner.zip', { expandedFromId: 'z' }))).toBe(false);
  });

  it('never waits on a row from an api that predates these fields', () => {
    const { expandedAt: _a, expansionNote: _n, expandedFromId: _f, ...legacy } = row('spec.zip');
    expect(awaitingExpansion(legacy)).toBe(false);
  });
});

describe('pollForExpansion', () => {
  const waiting = [row('notes.md'), row('spec.zip')];

  it('polls while an archive waits and a step can still expand it', () => {
    expect(pollForExpansion(waiting, false)).toBe(true);
  });

  it('never polls an ended task, which runs no step to expand anything', () => {
    // An archive uploaded after the task completed, failed or was cancelled waits forever.
    expect(pollForExpansion(waiting, true)).toBe(false);
  });

  it('never polls when nothing waits', () => {
    expect(pollForExpansion([row('notes.md')], false)).toBe(false);
  });
});
