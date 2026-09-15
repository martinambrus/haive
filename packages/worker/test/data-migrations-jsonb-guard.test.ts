import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `jsonb_typeof(x) = 'array' AND jsonb_array_length(x) > 0` reads like a guard and is not one:
// Postgres does not promise to evaluate an AND list as written, and jsonb_array_length
// raises on a non-array. The migration SQL here is literal (no interpolation), so the source text
// IS the statement — pinned as an invariant over the whole file, so a new unguarded call fails.
describe('data-migrations jsonb guards', () => {
  it('guards every jsonb_array_length call with a CASE', () => {
    const src = readFileSync(new URL('../src/data-migrations.ts', import.meta.url), 'utf8');
    const firstTokens = [...src.matchAll(/jsonb_array_length\(\s*(\S+)/g)].map((m) => m[1]);
    expect(firstTokens.length).toBeGreaterThan(0);
    expect(firstTokens.filter((t) => t !== 'CASE')).toEqual([]);
  });
});
