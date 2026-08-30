import { describe, expect, it } from 'vitest';
import { dropUnresolvableOps } from './apply-patch.js';
import type { PlanPatch } from '../schemas/plan.js';

const LIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Only LIVE exists in the repository. */
const tx = {
  select: () => ({
    from: () => ({ where: async () => [{ id: LIVE }] }),
  }),
} as never;

const run = async (ops: PlanPatch['ops'], seeded = new Map<string, string>()) => {
  const report: string[] = [];
  const kept = await dropUnresolvableOps(tx, ops, 'repo-1', seeded, report);
  return { kept, report };
};

describe('dropUnresolvableOps', () => {
  it('keeps the upserts and drops only the bad link', async () => {
    // The measured shape: an agent decomposed a component into children, then
    // named one wrong id in a cross-link. That link used to cost all of them.
    const { kept, report } = await run([
      { op: 'upsert', nodeRef: 'a', parentRef: LIVE, title: 'A' },
      { op: 'upsert', nodeRef: 'b', parentRef: LIVE, title: 'B' },
      { op: 'link', fromRef: 'a', toRef: GONE, kind: 'depends_on' },
    ] as PlanPatch['ops']);
    expect(kept.map((o) => o.op)).toEqual(['upsert', 'upsert']);
    expect(report).toHaveLength(1);
    expect(report[0]).toContain(GONE);
  });

  it('drops only the upsert whose parent is unknown', async () => {
    const { kept } = await run([
      { op: 'upsert', nodeRef: 'a', parentRef: LIVE, title: 'A' },
      { op: 'upsert', nodeRef: 'b', parentRef: GONE, title: 'B' },
    ] as PlanPatch['ops']);
    expect(kept).toHaveLength(1);
    expect((kept[0] as { nodeRef: string }).nodeRef).toBe('a');
  });

  it('cascades to ops that named a dropped upsert', async () => {
    // `b` never gets created, so a link to it cannot resolve either. One pass
    // would have kept the link and re-broken the patch.
    const { kept } = await run([
      { op: 'upsert', nodeRef: 'b', parentRef: GONE, title: 'B' },
      { op: 'upsert', nodeRef: 'c', parentRef: 'b', title: 'C' },
      { op: 'link', fromRef: 'c', toRef: LIVE, kind: 'affects' },
    ] as PlanPatch['ops']);
    expect(kept).toHaveLength(0);
  });

  it('keeps a temp-ref chain whose root resolves', async () => {
    const { kept, report } = await run([
      { op: 'upsert', nodeRef: 'b', parentRef: LIVE, title: 'B' },
      { op: 'upsert', nodeRef: 'c', parentRef: 'b', title: 'C' },
      { op: 'link', fromRef: 'c', toRef: LIVE, kind: 'affects' },
    ] as PlanPatch['ops']);
    expect(kept).toHaveLength(3);
    expect(report).toEqual([]);
  });

  it('resolves the seeded self alias', async () => {
    // The ref an expansion agent should never have to transcribe.
    const { kept } = await run(
      [{ op: 'upsert', nodeRef: 'a', parentRef: 'self', title: 'A' }] as PlanPatch['ops'],
      new Map([['self', LIVE]]),
    );
    expect(kept).toHaveLength(1);
  });

  it('drops an unlink naming a node that is gone', async () => {
    const { kept } = await run([
      { op: 'unlink', fromRef: LIVE, toRef: GONE, kind: 'depends_on' },
    ] as PlanPatch['ops']);
    expect(kept).toHaveLength(0);
  });

  it('leaves a clean patch untouched and reports nothing', async () => {
    const ops = [
      { op: 'upsert', nodeRef: 'a', parentRef: LIVE, title: 'A' },
      { op: 'link', fromRef: 'a', toRef: LIVE, kind: 'implements' },
    ] as PlanPatch['ops'];
    const { kept, report } = await run(ops);
    expect(kept).toEqual(ops);
    expect(report).toEqual([]);
  });
});
