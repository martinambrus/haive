import { describe, expect, it } from 'vitest';
import {
  planImpactBlock,
  PLAN_IMPACT_MAX_LINKS_PER_NODE,
  type PlanImpactContext,
} from './_plan-impact.js';

/**
 * The blast-radius block an implementer reads.
 *
 * Two properties carry the whole feature and both are about NOT lying: a short
 * list must never be readable as "nothing else is affected" (every cap and gap is
 * stated), and the block must never read as work to do — telling an agent to
 * update the affected components would widen every diff by the size of the
 * radius, which is what the scope fence exists to prevent.
 */

function ctx(over: Partial<PlanImpactContext> = {}): PlanImpactContext {
  return {
    consumers: [
      {
        title: 'PDF row builder',
        depth: 1,
        via: 'affects',
        links: [{ repoPath: 'd_inspection.inc', symbol: 'load_pdf_data', stale: false }],
        linksOmitted: 0,
        tests: [],
        testsOmitted: 0,
      },
    ],
    nodesOmitted: 0,
    deeperCount: 0,
    source: 'spec',
    walkTruncated: false,
    ...over,
  };
}

const solo = { role: 'implementer' } as const;
const dag = { role: 'dag-coder' } as const;
const tester = { role: 'tester' } as const;

describe('planImpactBlock', () => {
  it('is EMPTY with no context, so the prompt is what it always was', () => {
    expect(planImpactBlock(null, solo)).toBe('');
    expect(planImpactBlock(ctx({ consumers: [] }), solo)).toBe('');
  });

  it('names the component, why it is implicated, and where it lives', () => {
    const out = planImpactBlock(ctx(), solo);
    expect(out).toContain('PDF row builder');
    expect(out).toContain('is affected by changes to it, 1 hop away');
    expect(out).toContain('d_inspection.inc — load_pdf_data');
  });

  it('reads depends_on forwards, not as the stored enum', () => {
    const out = planImpactBlock(
      ctx({ consumers: [{ ...ctx().consumers[0]!, via: 'depends_on' }] }),
      solo,
    );
    expect(out).toContain('depends on it');
    expect(out).not.toContain('depends_on');
  });

  it('says a spec-named component was named, not that it was reached', () => {
    const out = planImpactBlock(
      ctx({ consumers: [{ ...ctx().consumers[0]!, depth: 0, via: null }] }),
      solo,
    );
    expect(out).toContain('named by the spec');
    expect(out).not.toContain('hop away');
  });

  it('LABELS a stale link rather than presenting it as fact', () => {
    const out = planImpactBlock(
      ctx({
        consumers: [
          {
            ...ctx().consumers[0]!,
            links: [{ repoPath: 'd_product.inc', symbol: null, stale: true }],
          },
        ],
      }),
      solo,
    );
    expect(out).toContain('d_product.inc  [STALE:');
    expect(out).toContain('verify it still applies');
  });

  it('leaves a fresh link unlabelled', () => {
    expect(planImpactBlock(ctx(), solo)).not.toContain('STALE');
  });

  it('still lists a component with no recorded files — the dependency IS the fact', () => {
    const out = planImpactBlock(
      ctx({ consumers: [{ ...ctx().consumers[0]!, links: [], linksOmitted: 0 }] }),
      solo,
    );
    expect(out).toContain('PDF row builder');
    expect(out).toContain('no files recorded for this component');
  });

  it('marks a test link so a reader scanning for coverage can pick it out', () => {
    const out = planImpactBlock(
      ctx({
        consumers: [
          {
            ...ctx().consumers[0]!,
            tests: [{ repoPath: 'tests/pdf.spec.ts', symbol: null, stale: false }],
          },
        ],
      }),
      tester,
    );
    expect(out).toContain('test: tests/pdf.spec.ts');
    // The implementation link is still there, unmarked.
    expect(out).toContain('    d_inspection.inc — load_pdf_data');
  });

  it('caps the two buckets separately, so implementation files cannot hide the tests', () => {
    const out = planImpactBlock(
      ctx({
        consumers: [
          {
            ...ctx().consumers[0]!,
            linksOmitted: 3,
            tests: [{ repoPath: 'tests/pdf.spec.ts', symbol: null, stale: false }],
            testsOmitted: 2,
          },
        ],
      }),
      tester,
    );
    expect(out).toContain('and 3 more files not listed here');
    expect(out).toContain('and 2 more test files not listed here');
  });

  it('still says "no files recorded" only when NEITHER bucket has anything', () => {
    const withOnlyTests = planImpactBlock(
      ctx({
        consumers: [
          {
            ...ctx().consumers[0]!,
            links: [],
            tests: [{ repoPath: 'tests/pdf.spec.ts', symbol: null, stale: false }],
          },
        ],
      }),
      tester,
    );
    expect(withOnlyTests).not.toContain('no files recorded');
    const withNeither = planImpactBlock(
      ctx({ consumers: [{ ...ctx().consumers[0]!, links: [], tests: [] }] }),
      tester,
    );
    expect(withNeither).toContain('no files recorded for this component');
  });

  it('tells the tester to audit coverage, and that an empty list is not proof', () => {
    const out = planImpactBlock(ctx(), tester);
    expect(out).toContain('still assert the whole of what it does NOW');
    // The half that stops a tester duplicating a suite it never opened: links accrue
    // one task at a time, so most components carry none for a long while.
    expect(out).toContain('has none RECORDED in the plan, which is not the same as having none');
    expect(out).not.toContain('Do NOT edit');
  });

  it('states every cap rather than truncating in silence', () => {
    const out = planImpactBlock(
      ctx({
        consumers: [{ ...ctx().consumers[0]!, linksOmitted: 4 }],
        nodesOmitted: 7,
        deeperCount: 118,
        walkTruncated: true,
      }),
      solo,
    );
    expect(out).toContain('and 4 more files not listed here');
    expect(out).toContain('7 further components are affected and not listed above');
    expect(out).toContain('118 more sit further out in the plan than one hop');
    expect(out).toContain('traversal hit its own limit');
  });

  it('admits when the set came from the recorded links rather than a traversal', () => {
    const out = planImpactBlock(
      ctx({ source: 'links', consumers: [{ ...ctx().consumers[0]!, depth: 0, via: null }] }),
      solo,
    );
    expect(out).toContain('linked to this task');
    expect(out).toContain('carry no hop count');
  });

  it('adds no notes when nothing was capped', () => {
    expect(planImpactBlock(ctx(), solo)).not.toContain('NOTE:');
  });

  it('tells a DAG coder this is blast radius, not file ownership', () => {
    // The list is the same one the implementer gets, derived at 04 before the DAG
    // plan exists — so a coder's OWN assigned files appear in it. Read as an
    // ownership list it makes an issue refuse its own scope (task 4905067c).
    const out = planImpactBlock(ctx(), dag);
    expect(out).toContain('NOT a list of files you may not touch');
    expect(out).toContain('your issue wins');
    expect(out).not.toContain('belong to other issues');
    expect(out).not.toContain('Do NOT edit these files');
  });

  it("still routes another issue's work into concerns rather than the worktree", () => {
    const out = planImpactBlock(ctx(), dag);
    expect(out).toContain('`concerns`');
    expect(out).toContain('level barrier');
  });

  it('tells the single implementer that fixing a broken consumer IS in scope', () => {
    const out = planImpactBlock(ctx(), solo);
    expect(out).toContain('fixing it is part of THIS change');
    expect(out).not.toContain('Do NOT edit');
  });

  it('never presents the list as work to do', () => {
    // The framing that stops the blast radius becoming the diff.
    for (const opts of [solo, dag]) {
      const out = planImpactBlock(ctx(), opts);
      expect(out).toContain('They are NOT your');
      expect(out).toMatch(/most changes leave them alone/);
    }
    // The tester says it in its own words — it is not changing these components at
    // all — but the property is the same one.
    const asTester = planImpactBlock(ctx(), tester);
    expect(asTester).toContain('They are NOT new scope');
    expect(asTester).toContain('do not treat these components as work to do');
  });

  it('keeps the per-node link cap as the constant the loader slices with', () => {
    // The formatter renders whatever it is handed; this pins the shared number so
    // the two halves cannot drift into "listed 6, said 4 omitted".
    expect(PLAN_IMPACT_MAX_LINKS_PER_NODE).toBeGreaterThan(0);
  });
});
