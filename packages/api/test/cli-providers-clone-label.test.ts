import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { makeCopyLabel, nextAvailableCloneLabel } from '../src/routes/cli-providers.js';

function makeDb(labels: string[]): Database {
  return {
    query: {
      cliProviders: {
        findMany: async () => labels.map((label) => ({ label })),
      },
    },
  } as unknown as Database;
}

describe('makeCopyLabel', () => {
  it('appends " Copy" for n = 1', () => {
    expect(makeCopyLabel('Claude', 1)).toBe('Claude Copy');
  });

  it('appends " Copy N" for n > 1', () => {
    expect(makeCopyLabel('Claude', 2)).toBe('Claude Copy 2');
    expect(makeCopyLabel('Claude', 42)).toBe('Claude Copy 42');
  });

  it('keeps labels under the 255-char column limit by trimming the base', () => {
    const base = 'x'.repeat(300);
    const result = makeCopyLabel(base, 1);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(' Copy')).toBe(true);
  });

  it('preserves the " Copy N" suffix when trimming a very long base', () => {
    const base = 'x'.repeat(300);
    const result = makeCopyLabel(base, 99);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(' Copy 99')).toBe(true);
  });

  it('works on labels that already contain the word "Copy"', () => {
    expect(makeCopyLabel('Claude Copy', 1)).toBe('Claude Copy Copy');
    expect(makeCopyLabel('Claude Copy', 3)).toBe('Claude Copy Copy 3');
  });
});

describe('nextAvailableCloneLabel', () => {
  it('returns "Label Copy" when no copies of the label exist yet', async () => {
    const db = makeDb(['Claude']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude')).toBe('Claude Copy');
  });

  it('returns "Label Copy 2" when "Label Copy" already exists', async () => {
    const db = makeDb(['Claude', 'Claude Copy']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude')).toBe('Claude Copy 2');
  });

  it('increments past "Label Copy 2" when both copies exist', async () => {
    const db = makeDb(['Claude', 'Claude Copy', 'Claude Copy 2']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude')).toBe('Claude Copy 3');
  });

  it('fills gaps in the existing Copy numbering instead of skipping them', async () => {
    const db = makeDb(['Claude', 'Claude Copy', 'Claude Copy 3']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude')).toBe('Claude Copy 2');
  });

  it('does not collide with unrelated labels on the same user', async () => {
    const db = makeDb(['Claude', 'Codex', 'Gemini Copy', 'Grok']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude')).toBe('Claude Copy');
  });

  it('clones a label that already ends with " Copy"', async () => {
    const db = makeDb(['Claude Copy']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude Copy')).toBe('Claude Copy Copy');
  });

  it('clones a label that already ends with " Copy N"', async () => {
    const db = makeDb(['Claude Copy 2']);
    expect(await nextAvailableCloneLabel(db, 'user-1', 'Claude Copy 2')).toBe('Claude Copy 2 Copy');
  });
});
