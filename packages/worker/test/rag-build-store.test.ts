import { describe, expect, it } from 'vitest';
import { secretMaskPolicy } from '../src/queues/cli-exec/secret-mask-policy.js';
import { chunkKey } from '../src/step-engine/steps/onboarding/10-rag-populate.js';
import {
  dropMaskedPaths,
  staleChunks,
  StoreRefusedError,
  storeDatabaseName,
  validateEmbeddings,
} from '../scripts/rag-build-store.js';

describe('storeDatabaseName', () => {
  it.each(['elmont_rs', 'rs_final', 'kb_global', 'RS-Final', ' elmont_rs '])(
    'refuses the live store %s',
    (name) => {
      expect(() => storeDatabaseName(name)).toThrow(StoreRefusedError);
    },
  );

  it('refuses an empty name', () => {
    expect(() => storeDatabaseName('')).toThrow(StoreRefusedError);
    expect(() => storeDatabaseName('  ')).toThrow(StoreRefusedError);
  });

  it('maps a scratch name to its rag database', () => {
    expect(storeDatabaseName('p0_smoke')).toMatch(/_rag_p0_smoke$/);
  });
});

describe('validateEmbeddings', () => {
  it('returns vectors of the expected count and length', () => {
    const vecs = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    expect(validateEmbeddings(vecs, 2, 2)).toBe(vecs);
  });

  it('rejects a wrong count', () => {
    expect(() => validateEmbeddings([[0.1, 0.2]], 2, 2)).toThrow(/1 vectors for 2 inputs/);
    expect(() => validateEmbeddings(undefined, 1, 2)).toThrow(/no vectors/);
  });

  it('rejects a wrong length', () => {
    expect(() => validateEmbeddings([[0.1, 0.2, 0.3]], 1, 2)).toThrow(/3 dimensions, expected 2/);
  });

  it('rejects a non-finite value', () => {
    expect(() => validateEmbeddings([[0.1, Number.NaN]], 1, 2)).toThrow(/non-finite/);
  });
});

describe('staleChunks', () => {
  it('returns the stored chunks this run did not produce', () => {
    const kept = chunkKey('a.php', 's1', 0);
    const gone = chunkKey('b.php', 's2', 3);
    const stale = staleChunks([kept, gone], new Set([kept, chunkKey('c.php', 's', 0)]));
    expect(stale).toEqual([{ sourcePath: 'b.php', sectionId: 's2', chunkIndex: 3 }]);
  });

  it('returns nothing when every stored chunk was produced', () => {
    const key = chunkKey('a.php', 's1', 0);
    expect(staleChunks([key], new Set([key]))).toEqual([]);
  });
});

describe('dropMaskedPaths', () => {
  it('drops a denied path and keeps a tracked denied path', () => {
    const files = ['src/a.php', '.env', 'config/.env.production', 'secrets/key.pem'];
    const untracked = secretMaskPolicy({ tracked: new Set(['src/a.php']) });
    expect(dropMaskedPaths(untracked, files)).toEqual({
      kept: ['src/a.php'],
      masked: ['.env', 'config/.env.production', 'secrets/key.pem'],
    });
    const tracked = secretMaskPolicy({ tracked: new Set(['.env']) });
    expect(dropMaskedPaths(tracked, ['.env', 'src/a.php']).kept).toEqual(['.env', 'src/a.php']);
  });

  it('treats an unlistable tree as all untracked', () => {
    const policy = secretMaskPolicy({ tracked: null });
    expect(dropMaskedPaths(policy, ['.env']).masked).toEqual(['.env']);
  });
});
