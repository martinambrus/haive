import { describe, expect, it } from 'vitest';
import {
  chunkKey,
  computeStaleKeys,
  resolvePopulateMode,
  insertChunk,
} from '../src/step-engine/steps/onboarding/10-rag-populate.js';
import type { RagConnection } from '../src/step-engine/steps/onboarding/_rag-connection.js';

describe('chunkKey', () => {
  it('is stable and distinct per (path, section, index)', () => {
    expect(chunkKey('a.md', 's1', 0)).toBe(chunkKey('a.md', 's1', 0));
    expect(chunkKey('a.md', 's1', 0)).not.toBe(chunkKey('a.md', 's1', 1));
    expect(chunkKey('a.md', 's1', 0)).not.toBe(chunkKey('b.md', 's1', 0));
    expect(chunkKey('a.md', 's1', 0)).not.toBe(chunkKey('a.md', 's2', 0));
  });
});

describe('computeStaleKeys', () => {
  it('returns existing keys that were not re-seen this run', () => {
    const existing = ['k1', 'k2', 'k3'];
    const seen = new Set(['k1', 'k3', 'k4']);
    expect(computeStaleKeys(existing, seen)).toEqual(['k2']);
  });

  it('returns [] when every existing key was seen', () => {
    expect(computeStaleKeys(['k1', 'k2'], new Set(['k1', 'k2']))).toEqual([]);
  });
});

describe('resolvePopulateMode', () => {
  it('defaults to incremental when a repository is present', () => {
    expect(resolvePopulateMode({}, 'repo-1')).toBe('incremental');
    expect(resolvePopulateMode(undefined, 'repo-1')).toBe('incremental');
  });

  it('forces full for a repo-less task (no partial unique index coverage)', () => {
    expect(resolvePopulateMode({ populateMode: 'incremental' }, null)).toBe('full');
  });

  it('maps legacy truncateExisting:true to full', () => {
    expect(resolvePopulateMode({ truncateExisting: true }, 'repo-1')).toBe('full');
  });

  it('honours an explicit populateMode over the legacy flag', () => {
    expect(resolvePopulateMode({ populateMode: 'full' }, 'repo-1')).toBe('full');
    expect(
      resolvePopulateMode({ populateMode: 'incremental', truncateExisting: true }, 'repo-1'),
    ).toBe('incremental');
  });
});

describe('insertChunk upsert SQL', () => {
  function fakeConn(): { conn: RagConnection; sql: () => string } {
    let last = '';
    const conn = {
      pg: {
        unsafe: async (q: string) => {
          last = q;
          return [];
        },
      },
    } as unknown as RagConnection;
    return { conn, sql: () => last };
  }

  it('appends ON CONFLICT DO UPDATE only when upsert is true', async () => {
    const { conn, sql } = fakeConn();
    await insertChunk(conn, false, 't', 'r', 'kb', 'p.md', 's', 0, 'h', 'body', [0.1, 0.2], true);
    expect(sql()).toContain('ON CONFLICT');
    expect(sql()).toContain('DO UPDATE');
    expect(sql()).toContain('embedding_json = EXCLUDED.embedding_json');

    await insertChunk(conn, false, 't', 'r', 'kb', 'p.md', 's', 0, 'h', 'body', [0.1, 0.2], false);
    expect(sql()).not.toContain('ON CONFLICT');
  });
});
