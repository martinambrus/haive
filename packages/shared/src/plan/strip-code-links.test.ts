import { describe, expect, it } from 'vitest';
import { stripInvalidCodeLinks } from './apply-patch.js';
import { planPatchSchema } from '../schemas/plan.js';

const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const strip = (patch: unknown) => {
  const report: string[] = [];
  const out = stripInvalidCodeLinks(patch, report) as { ops: Record<string, unknown>[] };
  return { out, report };
};

describe('stripInvalidCodeLinks', () => {
  it('keeps the op whose links carried their path under another key', () => {
    // The first measured shape: three links on one op, each with its path under
    // a key the schema does not know, cost the whole reply.
    const patch = {
      ops: [
        {
          op: 'upsert',
          nodeRef: 'api',
          parentRef: NODE,
          title: 'API',
          codeLinks: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
        },
      ],
    };
    const { out, report } = strip(patch);
    expect(out.ops[0]).toMatchObject({ nodeRef: 'api', title: 'API', codeLinks: [] });
    expect(report).toHaveLength(3);
    expect(report[0]).toMatch(/^code link dropped from 'api': repoPath: /);
    expect(planPatchSchema.safeParse(out).success).toBe(true);
  });

  it('drops only the link whose symbol is too long, keeping its sibling', () => {
    // The second measured shape: one `symbol` past 512 characters.
    const good = { repoPath: 'src/app.ts', symbol: 'boot' };
    const patch = {
      ops: [
        {
          op: 'upsert',
          nodeRef: NODE,
          codeLinks: [good, { repoPath: 'src/app.ts', symbol: 'x'.repeat(600) }],
        },
      ],
    };
    const { out, report } = strip(patch);
    expect(out.ops[0]?.codeLinks).toEqual([good]);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatch(new RegExp(`^code link dropped from '${NODE}': symbol: `));
    expect(planPatchSchema.safeParse(out).success).toBe(true);
  });

  it('removes a codeLinks value that is not a list', () => {
    const { out, report } = strip({
      ops: [{ op: 'upsert', nodeRef: NODE, codeLinks: { repoPath: 'a.ts' } }],
    });
    expect(out.ops[0]).not.toHaveProperty('codeLinks');
    expect(report).toEqual([`code links dropped from '${NODE}': not a list`]);
    expect(planPatchSchema.safeParse(out).success).toBe(true);
  });

  it('leaves valid links, and ops that are not upserts, exactly as they were', () => {
    const upsert = { op: 'upsert', nodeRef: NODE, codeLinks: [{ repoPath: 'a.ts' }] };
    const link = { op: 'link', fromRef: NODE, toRef: NODE, kind: 'affects', codeLinks: 'x' };
    const { out, report } = strip({ ops: [upsert, link] });
    expect(out.ops[0]).toBe(upsert);
    expect(out.ops[1]).toBe(link);
    expect(report).toEqual([]);
  });

  it('never rewrites the patch it was given', () => {
    const patch = {
      ops: [{ op: 'upsert', nodeRef: NODE, codeLinks: [{ path: 'a.ts' }, { repoPath: 'b.ts' }] }],
    };
    const before = structuredClone(patch);
    strip(patch);
    expect(patch).toEqual(before);
  });

  it('passes anything without an ops list through untouched', () => {
    const report: string[] = [];
    expect(stripInvalidCodeLinks(null, report)).toBeNull();
    const noOps = { summary: 'x' };
    expect(stripInvalidCodeLinks(noOps, report)).toBe(noOps);
    expect(report).toEqual([]);
  });
});
