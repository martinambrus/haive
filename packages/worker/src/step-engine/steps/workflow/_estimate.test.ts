import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { type Database } from '@haive/database';
import {
  buildAnchors,
  MAX_ANCHORS,
  rankPlanProximity,
  computeBiasFactor,
  effortHoursFromSteps,
  fileOverlapTaskIds,
  estimateRange,
  heuristicEstimate,
  overlapRefinedEstimate,
  type EstimateAnchor,
} from './_estimate.js';
import type { TaskTimingStep } from '@haive/shared/timing';

function anchor(effortHours: number, over: Partial<EstimateAnchor> = {}): EstimateAnchor {
  return {
    title: 't',
    description: 'd',
    executionPath: null,
    fixRounds: 0,
    effortHours,
    aiEstimateHours: null,
    confirmedEstimateHours: null,
    changedPaths: [],
    crossRepo: false,
    ...over,
  };
}

describe('effortHoursFromSteps', () => {
  it('sums work + user-active across steps into hours (idle excluded)', () => {
    const steps: TaskTimingStep[] = [
      // 1h of pure work.
      {
        startedAt: new Date(0),
        endedAt: new Date(3_600_000),
        idleMs: 0,
        userActiveMs: 0,
        waitingStartedAt: null,
        status: 'done',
      },
      // 30m span that was all idle, but 30m of user-active time at the gate.
      {
        startedAt: new Date(10_000_000),
        endedAt: new Date(11_800_000),
        idleMs: 1_800_000,
        userActiveMs: 1_800_000,
        waitingStartedAt: null,
        status: 'done',
      },
    ];
    // work 1h + user-active 0.5h = 1.5h; the idle 0.5h is excluded.
    expect(effortHoursFromSteps(steps, 20_000_000)).toBe(1.5);
  });

  it('a task with no steps has zero effort', () => {
    expect(effortHoursFromSteps([], 1)).toBe(0);
  });
});

describe('heuristicEstimate', () => {
  it('no anchors -> per-path cold-start baseline', () => {
    expect(heuristicEstimate([], 'quick_bugfix').hours).toBe(0.5);
    expect(heuristicEstimate([], 'plan_tasklist').hours).toBe(2);
    expect(heuristicEstimate([], 'full_workflow').hours).toBe(6);
  });

  it('scales the median anchor effort by the path', () => {
    // median([2,4]) = 3; quick scales 0.5x -> 1.5.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'quick_bugfix').hours).toBe(1.5);
    // median([2,4]) = 3; plan scales 1x -> 3.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'plan_tasklist').hours).toBe(3);
    // full scales 1.5x -> 4.5.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'full_workflow').hours).toBe(4.5);
  });

  it('ignores zero-effort anchors when computing the median', () => {
    expect(heuristicEstimate([anchor(0), anchor(4)], 'plan_tasklist').hours).toBe(4);
  });

  it('counts cross-repo anchors in the median (cold-start seed)', () => {
    // median([2,4]) = 3; cross-repo anchors DO feed the heuristic baseline.
    const anchors = [anchor(2, { crossRepo: true }), anchor(4, { crossRepo: true })];
    expect(heuristicEstimate(anchors, 'plan_tasklist').hours).toBe(3);
  });

  it.each(['quick_bugfix', 'full_workflow'])(
    'uses measured %s effort without applying the multiplier again',
    (path) => {
      const anchors = [1, 2, 3].map((h) => anchor(h, { executionPath: path }));
      anchors.push(anchor(100, { executionPath: 'plan_tasklist' }));
      expect(heuristicEstimate(anchors, path).hours).toBe(2);
      expect(heuristicEstimate(anchors, path).reason).toContain('no path scaling needed');
    },
  );

  it('discloses broader-history fallback when same-path measurements are sparse', () => {
    const anchors = [
      anchor(1, { executionPath: 'quick_bugfix' }),
      anchor(0, { executionPath: 'quick_bugfix' }),
      anchor(0, { executionPath: 'quick_bugfix' }),
      anchor(8, { executionPath: 'full_workflow' }),
      anchor(12, { executionPath: 'full_workflow' }),
    ];
    expect(heuristicEstimate(anchors, 'quick_bugfix').hours).toBe(4);
    expect(heuristicEstimate(anchors, 'quick_bugfix').reason).toContain('broader');
  });

  it('prefers adequate local same-path history over same-path cross-repo history', () => {
    const anchors = [1, 2, 3].map((h) => anchor(h, { executionPath: 'quick_bugfix' }));
    anchors.push(
      ...[50, 60, 70, 80].map((h) => anchor(h, { executionPath: 'quick_bugfix', crossRepo: true })),
    );
    expect(heuristicEstimate(anchors, 'quick_bugfix').hours).toBe(2);
  });

  it('uses same-path cross-repo history for a cold start without double scaling', () => {
    const anchors = [1, 2, 3].map((h) =>
      anchor(h, { executionPath: 'quick_bugfix', crossRepo: true }),
    );
    anchors.push(anchor(50, { executionPath: 'full_workflow', crossRepo: true }));
    expect(heuristicEstimate(anchors, 'quick_bugfix').hours).toBe(2);
  });
});

describe('buildAnchors', () => {
  const prior = (id: string, executionPath: string | null) => ({
    id,
    executionPath,
    title: id,
    description: '',
    currentRound: 0,
    changedPaths: [],
    aiEstimatedTimeHours: null,
    estimatedTimeHours: null,
    completedAt: new Date(3_600_000),
  });
  type Prior = ReturnType<typeof prior>;
  const mockDb = (batches: Prior[][], measured: string[]) => {
    const findMany = vi.fn();
    for (const batch of batches) findMany.mockResolvedValueOnce(batch);
    const db = {
      query: {
        tasks: { findMany },
        taskSteps: {
          findMany: vi.fn().mockResolvedValue(
            measured.map((taskId) => ({
              taskId,
              startedAt: new Date(0),
              endedAt: new Date(3_600_000),
              idleMs: 0,
              userActiveMs: 0,
              waitingStartedAt: null,
              status: 'done',
            })),
          ),
        },
        repositories: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    };
    return { db: db as unknown as Database, findMany };
  };

  it('finds older same-path runs beyond a full budget of preferred other-path runs', async () => {
    const preferred = Array.from({ length: MAX_ANCHORS }, (_, i) =>
      prior(`full-${i}`, 'full_workflow'),
    );
    const matching = [
      prior('fix-1', 'quick_bugfix'),
      prior('fix-2', 'quick_bugfix'),
      prior('fix-3', 'quick_bugfix'),
    ];
    const { db, findMany } = mockDb(
      [preferred, matching],
      [...preferred, ...matching].map((p) => p.id),
    );
    const anchors = await buildAnchors(
      db,
      'current',
      'repo',
      preferred.map((p) => p.id),
      'quick_bugfix',
    );
    expect(anchors.map((a) => a.title)).toEqual(['fix-1', 'fix-2', 'fix-3']);
    // The separate database query must constrain the path, repository and completed
    // workflow state; sorting just the existing 30 candidates cannot recover old fixes.
    const query = new PgDialect().sqlToQuery(findMany.mock.calls[1]![0].where);
    expect(query.sql).toContain('"tasks"."execution_path"');
    expect(query.params).toEqual(['repo', 'workflow', 'completed', 'current', 'quick_bugfix']);
  });

  it('retains semantic order within the same path and deduplicates recent matches', async () => {
    const preferred = [
      prior('fix-2', 'quick_bugfix'),
      prior('full', 'full_workflow'),
      prior('fix-1', 'quick_bugfix'),
    ];
    const matching = [
      prior('fix-3', 'quick_bugfix'),
      prior('fix-2', 'quick_bugfix'),
      prior('fix-1', 'quick_bugfix'),
    ];
    const { db } = mockDb([preferred, matching], ['fix-1', 'fix-2', 'fix-3', 'full']);
    const anchors = await buildAnchors(
      db,
      'current',
      'repo',
      preferred.map((p) => p.id),
      'quick_bugfix',
    );
    expect(anchors.map((a) => a.title)).toEqual(['fix-2', 'fix-1', 'fix-3']);
  });

  it('tops up sparse measured same-path history with broader runs, without duplicates', async () => {
    const preferred = [prior('full', 'full_workflow'), prior('fix-1', 'quick_bugfix')];
    const matching = [
      prior('fix-1', 'quick_bugfix'),
      prior('unmeasured-1', 'quick_bugfix'),
      prior('unmeasured-2', 'quick_bugfix'),
    ];
    const newest = [...matching, prior('plan', 'plan_tasklist'), prior('full', 'full_workflow')];
    const { db } = mockDb([preferred, matching, newest], ['fix-1', 'full', 'plan']);
    const anchors = await buildAnchors(
      db,
      'current',
      'repo',
      preferred.map((p) => p.id),
      'quick_bugfix',
    );
    expect(anchors.map((a) => a.title)).toEqual(['fix-1', 'full', 'plan']);
  });

  it('keeps the original preferred/newest ordering when the path is unknown', async () => {
    const preferred = [prior('full', 'full_workflow')];
    const newest = [prior('fix', 'quick_bugfix'), ...preferred];
    const { db } = mockDb([preferred, newest], ['full', 'fix']);
    const anchors = await buildAnchors(db, 'current', 'repo', ['full']);
    expect(anchors.map((a) => a.title)).toEqual(['full', 'fix']);
  });
});

describe('fileOverlapTaskIds', () => {
  it('keeps same-path overlapping tasks ahead of a full budget of other-path matches', async () => {
    const rows = [
      ...Array.from({ length: MAX_ANCHORS }, (_, i) => ({
        id: `full-${i}`,
        executionPath: 'full_workflow',
        changedPaths: ['a', 'b'],
        completedAt: new Date(10_000),
      })),
      {
        id: 'fix-old',
        executionPath: 'quick_bugfix',
        changedPaths: ['a'],
        completedAt: new Date(0),
      },
      {
        id: 'fix-new',
        executionPath: 'quick_bugfix',
        changedPaths: ['a'],
        completedAt: new Date(1000),
      },
    ];
    const db = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as Database;
    const ids = await fileOverlapTaskIds(db, 'current', 'repo', ['a', 'b'], 'quick_bugfix');
    expect(ids.slice(0, 2)).toEqual(['fix-new', 'fix-old']);
    expect(ids).toHaveLength(MAX_ANCHORS + 2);
  });
});

describe('overlapRefinedEstimate', () => {
  it('prefers same-path file overlaps so refinement does not restore mixed-path bias', () => {
    const anchors = [
      anchor(2, { executionPath: 'plan_tasklist', changedPaths: ['a'] }),
      anchor(4, { executionPath: 'plan_tasklist', changedPaths: ['a'] }),
      anchor(90, { executionPath: 'full_workflow', changedPaths: ['a', 'b'] }),
    ];
    expect(overlapRefinedEstimate(anchors, ['a', 'b'], 'plan_tasklist')).toEqual({
      hours: 3,
      overlapAnchors: 2,
      matchedFiles: 1,
    });
    expect(overlapRefinedEstimate(anchors, ['a', 'b'], 'full_workflow')?.overlapAnchors).toBe(3);
  });
  it('returns null when no files are predicted', () => {
    expect(overlapRefinedEstimate([anchor(2, { changedPaths: ['a'] })], [])).toBeNull();
  });

  it('returns null with fewer than 2 overlapping anchors', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a', 'b'] }),
      anchor(4, { changedPaths: ['x', 'y'] }), // no overlap with ['a']
    ];
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });

  it('takes the median effort of the prior tasks that touched the predicted files', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a', 'b'] }),
      anchor(4, { changedPaths: ['a', 'c'] }),
      anchor(99, { changedPaths: ['x'] }), // no overlap -> excluded
    ];
    const r = overlapRefinedEstimate(anchors, ['a']);
    expect(r).not.toBeNull();
    expect(r!.hours).toBe(3); // median([2,4])
    expect(r!.overlapAnchors).toBe(2);
    expect(r!.matchedFiles).toBe(1); // only 'a' matched
  });

  it('excludes overlapping anchors that have zero measured effort', () => {
    const anchors = [anchor(0, { changedPaths: ['a'] }), anchor(6, { changedPaths: ['a'] })];
    // Only one anchor has effort>0 AND overlap -> below the min, so null.
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });

  it('excludes cross-repo anchors from file overlap (coincidental path match)', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a'], crossRepo: true }),
      anchor(4, { changedPaths: ['a'], crossRepo: true }),
      anchor(6, { changedPaths: ['a'] }), // the only LOCAL overlap
    ];
    // The two cross-repo overlaps are ignored; one local overlap is below the min -> null.
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });
});

describe('rankPlanProximity', () => {
  const at = (iso: string) => new Date(iso);
  const NODE = 'node-self';

  it('puts a same-node task ahead of a nearer-in-time sibling task', () => {
    // Tier beats recency: implementing the very node in hand is a stronger signal than
    // having recently implemented something next to it.
    const ids = rankPlanProximity(
      [
        { taskId: 'same-old', nodeId: NODE, completedAt: at('2026-01-01') },
        { taskId: 'sibling-new', nodeId: 'node-sibling', completedAt: at('2026-06-01') },
      ],
      [NODE],
    );
    expect(ids).toEqual(['same-old', 'sibling-new']);
  });

  it('orders newest-completed first within a tier', () => {
    const ids = rankPlanProximity(
      [
        { taskId: 'older', nodeId: 'a', completedAt: at('2026-01-01') },
        { taskId: 'newer', nodeId: 'b', completedAt: at('2026-05-01') },
      ],
      [NODE],
    );
    expect(ids).toEqual(['newer', 'older']);
  });

  it('ranks a task by the CLOSEST node it reached, not by how many matched', () => {
    // Otherwise a task linked to a dozen distant nodes outranks one that implements
    // exactly the node in hand.
    const ids = rankPlanProximity(
      [
        { taskId: 'broad', nodeId: 'far-1', completedAt: at('2026-07-01') },
        { taskId: 'broad', nodeId: 'far-2', completedAt: at('2026-07-01') },
        { taskId: 'exact', nodeId: NODE, completedAt: at('2026-02-01') },
      ],
      [NODE],
    );
    expect(ids).toEqual(['exact', 'broad']);
  });

  it('returns each task once even when several of its rows match', () => {
    const ids = rankPlanProximity(
      [
        { taskId: 't', nodeId: NODE, completedAt: at('2026-03-01') },
        { taskId: 't', nodeId: 'sibling', completedAt: at('2026-03-01') },
      ],
      [NODE],
    );
    expect(ids).toEqual(['t']);
  });

  it('treats a task with no completion date as the oldest rather than dropping it', () => {
    const ids = rankPlanProximity(
      [
        { taskId: 'undated', nodeId: 'a', completedAt: null },
        { taskId: 'dated', nodeId: 'b', completedAt: at('2026-01-01') },
      ],
      [NODE],
    );
    expect(ids).toEqual(['dated', 'undated']);
  });

  it('caps the list at the anchor budget', () => {
    const rows = Array.from({ length: MAX_ANCHORS + 5 }, (_, i) => ({
      taskId: `t${i}`,
      nodeId: 'sibling',
      completedAt: at('2026-01-01'),
    }));
    expect(rankPlanProximity(rows, [NODE])).toHaveLength(MAX_ANCHORS);
  });

  it('is empty with no rows', () => {
    expect(rankPlanProximity([], [NODE])).toEqual([]);
  });
});

describe('computeBiasFactor', () => {
  it('calibrates only from local same-path estimate/actual pairs', () => {
    const anchors = [
      anchor(2, { executionPath: 'quick_bugfix', aiEstimateHours: 4 }),
      anchor(4, { executionPath: 'quick_bugfix', aiEstimateHours: 4 }),
      anchor(90, { executionPath: 'full_workflow', aiEstimateHours: 1 }),
      anchor(90, { executionPath: 'full_workflow', aiEstimateHours: 1 }),
      anchor(90, { executionPath: 'quick_bugfix', aiEstimateHours: 1, crossRepo: true }),
    ];
    expect(computeBiasFactor(anchors, 'quick_bugfix')).toBe(0.75);
  });

  it('withholds calibration when same-path pairs are sparse, even with ample other-path history', () => {
    const anchors = [
      anchor(2, { executionPath: 'quick_bugfix', aiEstimateHours: 4 }),
      anchor(90, { executionPath: 'full_workflow', aiEstimateHours: 1 }),
      anchor(90, { executionPath: null, aiEstimateHours: 1 }),
    ];
    expect(computeBiasFactor(anchors, 'quick_bugfix')).toBeNull();
  });
  it('null with fewer than 2 anchors carrying both estimate and actual', () => {
    expect(computeBiasFactor([anchor(4, { aiEstimateHours: 2 })])).toBeNull();
    expect(computeBiasFactor([anchor(4), anchor(6)])).toBeNull(); // no aiEstimateHours
  });

  it('median ratio of actual to prior AI estimate', () => {
    // ratios 4/2=2 and 6/2=3 -> median 2.5.
    const anchors = [anchor(4, { aiEstimateHours: 2 }), anchor(6, { aiEstimateHours: 2 })];
    expect(computeBiasFactor(anchors)).toBe(2.5);
  });

  it('clamps an extreme ratio into [0.25, 4]', () => {
    const anchors = [anchor(100, { aiEstimateHours: 1 }), anchor(50, { aiEstimateHours: 1 })];
    expect(computeBiasFactor(anchors)).toBe(4);
  });

  it('excludes cross-repo anchors from the bias factor', () => {
    const anchors = [
      anchor(4, { aiEstimateHours: 2, crossRepo: true }),
      anchor(6, { aiEstimateHours: 2, crossRepo: true }),
      anchor(4, { aiEstimateHours: 2 }), // the only LOCAL (estimate, actual) pair
    ];
    // Two cross-repo pairs ignored; one local pair is below the min -> null.
    expect(computeBiasFactor(anchors)).toBeNull();
  });
});

describe('estimateRange', () => {
  it('uses same-path measurements without scaling the band twice', () => {
    const anchors = [1, 2, 3, 4, 5].map((h) => anchor(h, { executionPath: 'quick_bugfix' }));
    anchors.push(anchor(100, { executionPath: 'full_workflow' }));
    expect(estimateRange(anchors, 'quick_bugfix')).toEqual({ low: 2, high: 4 });
  });

  it('scales the broader-history fallback band consistently with the baseline', () => {
    const anchors = [1, 2, 3, 4, 5].map((h) => anchor(h, { executionPath: 'full_workflow' }));
    expect(estimateRange(anchors, 'quick_bugfix')).toEqual({ low: 1, high: 2 });
  });
  it('null with fewer than 3 usable anchors', () => {
    expect(estimateRange([anchor(2), anchor(4)])).toBeNull();
  });

  it('p20/p80 band from the anchor efforts', () => {
    // sorted [1,2,3,4,5]: p20 -> index 1 (2h), p80 -> index 3 (4h).
    const anchors = [anchor(1), anchor(2), anchor(3), anchor(4), anchor(5)];
    expect(estimateRange(anchors)).toEqual({ low: 2, high: 4 });
  });

  it('null when the band would collapse (all equal)', () => {
    expect(estimateRange([anchor(3), anchor(3), anchor(3)])).toBeNull();
  });
});
