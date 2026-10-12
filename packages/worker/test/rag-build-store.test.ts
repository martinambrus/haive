import { describe, expect, it } from 'vitest';
import { secretMaskPolicy } from '../src/queues/cli-exec/secret-mask-policy.js';
import { chunkKey } from '../src/step-engine/steps/onboarding/10-rag-populate.js';
import {
  assertNotLiveRepository,
  decideBuildMeta,
  dropMaskedPaths,
  staleChunks,
  StoreRefusedError,
  storeDatabaseName,
  validateEmbeddings,
  readBuildMeta,
  stringArrayEnv,
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

describe('assertNotLiveRepository', () => {
  const synthetic = '11111111-2222-4333-8444-555555555555';
  const real = '0e72847d-0dd8-4486-824d-c046a5d2f420';

  it('allows a synthetic id over a store holding only synthetic ids', () => {
    expect(() => assertNotLiveRepository(new Set(), synthetic, [synthetic])).not.toThrow();
    expect(() => assertNotLiveRepository(new Set(), synthetic, [])).not.toThrow();
  });

  it('refuses a RAG_REPOSITORY_ID that is a real repository', () => {
    expect(() => assertNotLiveRepository(new Set([real]), real, [])).toThrow(StoreRefusedError);
    expect(() => assertNotLiveRepository(new Set([real]), real.toUpperCase(), [])).toThrow(
      /repositories/,
    );
  });

  it('refuses a store whose rows belong to a real repository', () => {
    expect(() => assertNotLiveRepository(new Set([real]), synthetic, [synthetic, real])).toThrow(
      StoreRefusedError,
    );
  });
});

describe('decideBuildMeta', () => {
  const requested = { model: 'qwen3-embedding:4b', dims: 2560 };

  it('records the config in an empty or new store', () => {
    expect(decideBuildMeta(null, false, requested)).toEqual({ action: 'record' });
  });

  it('refuses a store with rows and no meta row', () => {
    const decision = decideBuildMeta(null, true, requested);
    expect(decision.action).toBe('refuse');
  });

  it('resumes a store built with the same model and width', () => {
    expect(decideBuildMeta({ ...requested }, true, requested)).toEqual({ action: 'resume' });
  });

  it('refuses a different model, naming both', () => {
    const decision = decideBuildMeta({ model: 'old-model', dims: 2560 }, true, requested);
    expect(decision).toMatchObject({ action: 'refuse' });
    expect(JSON.stringify(decision)).toContain('old-model');
    expect(JSON.stringify(decision)).toContain('qwen3-embedding:4b');
  });

  it('refuses a different width, naming both', () => {
    const decision = decideBuildMeta({ model: requested.model, dims: 1024 }, true, requested);
    expect(decision).toMatchObject({ action: 'refuse' });
    expect(JSON.stringify(decision)).toContain('1024');
    expect(JSON.stringify(decision)).toContain('2560');
  });
});

describe('stringArrayEnv', () => {
  it('reads a JSON array of strings and is undefined when unset', () => {
    process.env.RAG_T_ARR = '[".inc",".php"]';
    expect(stringArrayEnv('RAG_T_ARR')).toEqual(['.inc', '.php']);
    delete process.env.RAG_T_ARR;
    expect(stringArrayEnv('RAG_T_ARR')).toBeUndefined();
  });
});

describe('readBuildMeta', () => {
  const pgWith = (rel: string | null, rows: unknown[]) => ({
    unsafe: async (q: string) => (q.includes('to_regclass') ? [{ rel }] : rows),
  });

  it('is null when the store has no meta table', async () => {
    expect(await readBuildMeta(pgWith(null, []) as never)).toBeNull();
  });

  it('reads the recorded model and width', async () => {
    const pg = pgWith('rag_build_store_meta', [{ model: 'm', dims: '2560' }]);
    expect(await readBuildMeta(pg as never)).toEqual({ model: 'm', dims: 2560 });
  });
});
