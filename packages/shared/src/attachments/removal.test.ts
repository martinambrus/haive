import { describe, expect, it } from 'vitest';
import { archivesEmptiedBy, type ExtractedFromLink } from './removal.js';

const rows: ExtractedFromLink[] = [
  { id: 'zip', expandedFromId: null },
  { id: 'a', expandedFromId: 'zip' },
  { id: 'b', expandedFromId: 'zip' },
  { id: 'capped', expandedFromId: null },
  { id: 'upload' },
];
const emptied = (doomed: string[]): string[] =>
  archivesEmptiedBy(rows, new Set(doomed)).map((r) => r.id);

describe('archivesEmptiedBy', () => {
  it('names an archive once every file extracted from it is removed', () => {
    expect(emptied(['a', 'b'])).toEqual(['zip']);
  });

  it('keeps an archive while one of its files survives', () => {
    expect(emptied(['a'])).toEqual([]);
  });

  it('never names an archive that produced no file, or one already removed', () => {
    expect(emptied(['capped', 'upload'])).toEqual([]);
    expect(emptied(['zip', 'a', 'b'])).toEqual([]);
  });
});
