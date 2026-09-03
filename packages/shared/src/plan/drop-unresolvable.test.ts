import { describe, expect, it } from 'vitest';
import { dropUnresolvableOps, normalizeOpRefs } from './apply-patch.js';
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

describe('normalizeOpRefs', () => {
  // `renderPlanMarkdown` shows every id as `node:<uuid>` and the patch contract
  // tells the agent to copy ids rather than retype them. Obeying both produced a
  // ref that matched no live node, and the op was dropped as unknown.
  it('strips the marker the plan markdown shows ids with', () => {
    const [op] = normalizeOpRefs([
      { op: 'upsert', nodeRef: 'a', parentRef: `node:${LIVE}`, title: 'A' },
    ] as PlanPatch['ops']);
    expect((op as { parentRef: string }).parentRef).toBe(LIVE);
  });

  it('normalises every ref field, not just parentRef', () => {
    const ops = normalizeOpRefs([
      { op: 'upsert', nodeRef: `node:${LIVE}`, body: 'x' },
      { op: 'delete', nodeRef: `node:${LIVE}` },
      { op: 'link', fromRef: `node:${LIVE}`, toRef: `node:${GONE}`, kind: 'affects' },
      { op: 'unlink', fromRef: `node:${LIVE}`, toRef: `node:${GONE}`, kind: 'affects' },
    ] as PlanPatch['ops']);
    expect(JSON.stringify(ops)).not.toContain('node:');
  });

  it('leaves a temp id that merely starts with the marker alone', () => {
    // Only a uuid remainder is stripped, so an invented `node:api` still creates.
    const [op] = normalizeOpRefs([
      { op: 'upsert', nodeRef: 'node:api', parentRef: LIVE, title: 'API' },
    ] as PlanPatch['ops']);
    expect((op as { nodeRef: string }).nodeRef).toBe('node:api');
  });

  it('keeps a null parentRef null', () => {
    // `null` is the plan root, a different statement from "no parentRef given".
    const [op] = normalizeOpRefs([
      { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' },
    ] as PlanPatch['ops']);
    expect((op as { parentRef: unknown }).parentRef).toBeNull();
  });

  it('lets a prefixed ref survive the drop pre-flight', async () => {
    // The two composed in the order `applyOps` runs them. Un-normalised, this
    // op is discarded even though LIVE is a live node.
    const ops = [
      { op: 'upsert', nodeRef: 'a', parentRef: `node:${LIVE}`, title: 'A' },
    ] as PlanPatch['ops'];
    expect((await run(ops)).kept).toHaveLength(0);
    expect((await run(normalizeOpRefs(ops))).kept).toHaveLength(1);
  });
});
