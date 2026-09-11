import { describe, it, expect } from 'vitest';
import { loadMiningScopeExcludeGlobs } from '../src/step-engine/steps/onboarding/_scope.js';
import { AGENT_TOOLING_DIRS } from '../src/step-engine/steps/onboarding/_scope-seed.js';
import type { Database } from '@haive/database';

// 06_7 picks the mining scope BEFORE 07-generate-files creates the CLI dirs, and
// `computeSeedExcludeGlobs` filters every seed through the tree that exists at the time —
// so a tooling dir Haive is about to create can never be seeded. MEASURED on a live run:
// 06_7 finished 11:40:53, 07 wrote `.codex/agents/` at 11:54:53, and the KB miner was
// handed 34 of Haive's own generated agent definitions as project source. `.claude`
// escaped only because that repo already had one from a previous workflow.
const dbReturning = (excludeGlobs: string[] | undefined): Database =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              Promise.resolve(
                excludeGlobs
                  ? [{ detectOutput: null, output: { excludeGlobs }, iterations: [] }]
                  : [],
              ),
          }),
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
          limit: () => Promise.resolve([]),
        }),
        innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
    }),
  }) as unknown as Database;

describe('loadMiningScopeExcludeGlobs', () => {
  it('adds every agent-tooling dir even when the stored scope names none', async () => {
    const out = await loadMiningScopeExcludeGlobs(dbReturning(['includes', 'modules']), 't1');
    for (const d of AGENT_TOOLING_DIRS) expect(out, d).toContain(d);
  });

  it('specifically covers the dir 07 creates after the scope was chosen', async () => {
    const out = await loadMiningScopeExcludeGlobs(dbReturning(['includes']), 't1');
    expect(out).toContain('.codex');
    expect(out).toContain('.claude');
  });

  it("keeps the user's own choices", async () => {
    const out = await loadMiningScopeExcludeGlobs(
      dbReturning(['includes', 'sites/all/modules/ckeditor']),
      't1',
    );
    expect(out).toContain('includes');
    expect(out).toContain('sites/all/modules/ckeditor');
  });

  it('does not duplicate a tooling dir the scope already had', async () => {
    const out = await loadMiningScopeExcludeGlobs(dbReturning(['.claude', 'includes']), 't1');
    expect(out.filter((g) => g === '.claude')).toHaveLength(1);
  });

  // .haive-data holds the KB and learnings — indexed knowledge, never tooling.
  it('never excludes the managed knowledge dir', async () => {
    const out = await loadMiningScopeExcludeGlobs(dbReturning(['includes']), 't1');
    expect(out).not.toContain('.haive-data');
  });
});
