import { describe, expect, it } from 'vitest';
import {
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
