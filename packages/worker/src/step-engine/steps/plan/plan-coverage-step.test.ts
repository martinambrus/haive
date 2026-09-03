import { describe, expect, it } from 'vitest';
import {
  AUTO_CONVERGENCE_AGENTS_PER_PASS,
  continuationDispatchCount,
  effectiveCoverageMiningRow,
  planCoverageStep,
  unresolvedExpansionNodeIds,
} from './02-plan-coverage.js';
import { findPatchBreadthViolations } from './_plan-breadth.js';
import { PLAN_AGENT_TIMEOUT_MS } from './01-plan-build.js';
import { findStructuralGaps } from './plan-coverage-scan.js';
import type { FormSchema } from '@haive/shared';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { MiningWaveError } from '../../step-definition.js';

type Detected = Parameters<NonNullable<typeof planCoverageStep.form>>[1];

const detected = (over: Partial<Detected> = {}): Detected =>
  ({
    repositoryId: 'r1',
    structural: [],
    sections: [],
    sectionBodies: {},
    planMarkdown: '# Plan',
    nodeCount: 791,
    docNames: ['spec.md'],
    hasVisualInputs: false,
    buildDetect: null,
    buildFormValues: { depthBudget: 6, breadthCap: 12 },
    buildStopped: 'complete',
    frontierRemaining: 0,
    frontierPreview: [],
    continuationBatch: 1,
    automaticLimitReached: false,
    ...over,
  }) as Detected;

const formOf = (d: Detected) => planCoverageStep.form!({} as never, d) as FormSchema | null;

describe('the coverage gate', () => {
  it('retries a transiently failed recovery terminal once', () => {
    expect(planCoverageStep.agentMining?.timeoutMs).toBe(PLAN_AGENT_TIMEOUT_MS);
    expect(planCoverageStep.agentMining?.retry).toEqual({
      maxAttempts: 2,
      retryOnInvocationFailure: shouldRetryMiningTerminalFailure,
    });
  });

  it('does not park when the build left nothing behind', () => {
    // A clean build must finish unattended, exactly as before this step existed.
    expect(formOf(detected())).toBeNull();
  });

  it('parks when a decomposition was lost', () => {
    const form = formOf(
      detected({
        structural: [
          { nodeId: 'n1', title: 'Privacy', reason: 'its decomposition was rejected and lost' },
        ],
      }),
    );
    expect(form).not.toBeNull();
    expect(form!.fields.map((f) => f.id)).toEqual(['decision', 'items', 'note']);
  });

  it('runs semantic frontier review without parking the user', () => {
    expect(
      formOf(
        detected({
          buildStopped: 'node_budget',
          frontierRemaining: 512,
          frontierPreview: ['Unfinished branch'],
        }),
      ),
    ).toBeNull();
  });

  it('parks only when an automatic semantic pass reaches its safety budget', () => {
    const form = formOf(
      detected({
        buildStopped: 'node_budget',
        frontierRemaining: 512,
        frontierPreview: ['Unfinished branch'],
        automaticLimitReached: true,
      }),
    );
    expect(form).not.toBeNull();
    expect(form!.fields.map((field) => field.id)).toEqual(['decision']);
    const decision = form!.fields[0] as {
      default?: string;
      options: { value: string }[];
    };
    expect(decision.default).toBe('converge');
    expect(decision.options.map((option) => option.value)).toEqual(['converge', 'accept']);
    expect(form!.description).toContain('512 component node(s)');
    expect(form!.description).toContain('safety budget');
  });

  it('pre-ticks a known loss but not a heuristic guess', () => {
    // A lost decomposition is a fact the build recorded. An uncovered section is
    // a guess from term matching, so it must not be actioned by default.
    const form = formOf(
      detected({
        structural: [{ nodeId: 'n1', title: 'Privacy', reason: 'lost' }],
        sections: [
          {
            title: '7.8 Music',
            line: 9,
            source: 'spec.md',
            missingTerms: ['music'],
            matchedNodes: 0,
            score: 0,
          },
        ],
      }),
    );
    const items = form!.fields.find((f) => f.id === 'items') as { defaults?: string[] };
    expect(items.defaults).toEqual(['node:n1']);
  });

  it('offers accepting as an equal choice, not a hidden one', () => {
    const form = formOf(detected({ structural: [{ nodeId: 'n1', title: 'X', reason: 'lost' }] }));
    const decision = form!.fields.find((f) => f.id === 'decision') as {
      options: { value: string }[];
    };
    expect(decision.options.map((o) => o.value)).toEqual(['redecompose', 'accept']);
  });

  it('names the documents only when there were some', () => {
    // A from_repo build has no written authority to check against.
    const form = formOf(
      detected({ structural: [{ nodeId: 'n1', title: 'X', reason: 'lost' }], docNames: [] }),
    );
    expect(form!.description).not.toContain('undefined');
  });

  it('names every document a gap came from, not just the first', () => {
    // A plan can be built from several files at once; "3 sections of spec.md"
    // sends the reader to the wrong one.
    const form = formOf(
      detected({
        docNames: ['requirements.docx', 'fields.xlsx'],
        sections: [
          {
            title: '4.2 Reporting',
            line: 12,
            source: 'requirements.docx',
            missingTerms: ['reporting'],
            matchedNodes: 0,
            score: 0,
          },
        ],
      }),
    );
    expect(form!.description).toContain('requirements.docx, fields.xlsx');
    const items = form!.fields.find((f) => f.id === 'items') as {
      options: { value: string; label: string }[];
    };
    // The key is source-scoped, so two files' line 12 stay two gaps.
    expect(items.options.map((o) => o.value)).toContain('doc:requirements.docx:12');
    expect(items.options[0]!.label).toContain('(requirements.docx)');
  });

  it('says a term scan cannot see the images that were attached', () => {
    // Otherwise a clean scan reads as "the wireframe was covered". It was not
    // looked at: the scan reads text and an image contributes none.
    const form = formOf(
      detected({
        hasVisualInputs: true,
        structural: [{ nodeId: 'n1', title: 'X', reason: 'lost' }],
      }),
    );
    expect(form!.description).toContain('Images were attached');
  });
});

describe('bounded coverage continuation', () => {
  it('never dispatches more than twelve agents in one wave', () => {
    expect(continuationDispatchCount(512, 0)).toBe(12);
  });

  it('clamps the last wave to the automatic semantic-pass budget', () => {
    expect(AUTO_CONVERGENCE_AGENTS_PER_PASS).toBe(240);
    expect(continuationDispatchCount(512, 238)).toBe(2);
    expect(continuationDispatchCount(512, 240)).toBe(0);
  });

  it('revisits clean legacy empty replies but blocks failed expansion terminals', () => {
    const cleanLegacy = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const failedBuild = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rejectedContinuation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const failedRecovery = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const recoveredBuild = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const postRecoveryFailure = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const blocked = unresolvedExpansionNodeIds([
      {
        agentId: `plan-expand-${cleanLegacy}-p1`,
        status: 'done',
        errorMessage: null,
      },
      {
        agentId: `plan-expand-${failedBuild}-p2`,
        status: 'failed',
        errorMessage: 'CLI exited 1',
      },
      {
        agentId: `plan-continue-b1-${rejectedContinuation}-p3`,
        status: 'done',
        errorMessage: 'plan patch not applied: breadth exceeded',
      },
      {
        agentId: `cover-node-${failedRecovery}`,
        status: 'running',
        errorMessage: null,
      },
      {
        agentId: `plan-expand-${recoveredBuild}-p1`,
        status: 'failed',
        errorMessage: 'CLI exited 1',
      },
      {
        agentId: `plan-expand-${recoveredBuild}-p2`,
        status: 'done',
        errorMessage: null,
      },
      {
        agentId: `cover-node-${postRecoveryFailure}`,
        status: 'done',
        errorMessage: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        agentId: `plan-continue-b2-${postRecoveryFailure}-p1`,
        status: 'failed',
        errorMessage: 'CLI exited 1',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    ]);

    expect(blocked.has(cleanLegacy)).toBe(false);
    expect(blocked.has(recoveredBuild)).toBe(false);
    expect([...blocked]).toEqual([
      failedBuild,
      rejectedContinuation,
      failedRecovery,
      postRecoveryFailure,
    ]);
  });
});

describe('bounded coverage recovery', () => {
  const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const create = (nodeRef: string, parentRef: string) => ({
    op: 'upsert',
    nodeRef,
    parentRef,
    title: nodeRef,
  });

  it('puts the configured hard breadth limit in every recovery prompt', async () => {
    const applyError = await planCoverageStep.apply!(
      {} as never,
      {
        detected: detected({
          buildFormValues: { depthBudget: 6, breadthCap: 7 },
          structural: [{ nodeId: TARGET, title: 'Privacy', reason: 'lost' }],
        }),
        formValues: { decision: 'redecompose', items: [`node:${TARGET}`] },
      } as never,
    ).catch((error: unknown) => error);

    expect(applyError).toBeInstanceOf(MiningWaveError);
    expect((applyError as MiningWaveError).dispatches[0]?.prompt).toContain(
      'no parent touched by this patch may have more than 7 direct children in total',
    );
  });

  it('rejects more new siblings than the configured breadth', () => {
    const ops = Array.from({ length: 13 }, (_, index) => create(`tmp-${index}`, 'self'));
    expect(findPatchBreadthViolations(ops, 12, { selfNodeId: TARGET })).toEqual([
      {
        parentRef: TARGET,
        existingChildren: 0,
        newChildren: 13,
        totalChildren: 13,
      },
    ]);
  });

  it('includes already-persisted children in the hard limit', () => {
    const ops = [create('tmp-a', TARGET), create('tmp-b', TARGET)];
    expect(
      findPatchBreadthViolations(ops, 12, {
        existingChildren: new Map([[TARGET, 11]]),
      }),
    ).toEqual([
      {
        parentRef: TARGET,
        existingChildren: 11,
        newChildren: 2,
        totalChildren: 13,
      },
    ]);
  });

  it('allows a wide subject when the patch groups it into bounded parents', () => {
    const groups = [create('tmp-group-a', 'self'), create('tmp-group-b', 'self')];
    const leaves = Array.from({ length: 12 }, (_, index) =>
      create(`tmp-leaf-${index}`, index < 6 ? 'tmp-group-a' : 'tmp-group-b'),
    );
    expect(findPatchBreadthViolations([...groups, ...leaves], 6, { selfNodeId: TARGET })).toEqual(
      [],
    );
  });
});

describe('coverage mining settlement', () => {
  it('surfaces an ended failed invocation while its mining row still lags at running', () => {
    expect(
      effectiveCoverageMiningRow({
        agentId: 'plan-continue-b1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-p3',
        status: 'running',
        errorMessage: null,
        invocationExitCode: 1,
        invocationEndedAt: new Date(),
        invocationErrorMessage: 'prompt exceeded provider input limit',
      }),
    ).toEqual({
      agentId: 'plan-continue-b1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-p3',
      status: 'failed',
      errorMessage: 'prompt exceeded provider input limit',
    });
  });

  it('does not promote an ended success before its mining output has folded', () => {
    expect(
      effectiveCoverageMiningRow({
        agentId: 'a',
        status: 'running',
        errorMessage: null,
        invocationExitCode: 0,
        invocationEndedAt: new Date(),
        invocationErrorMessage: null,
      }).status,
    ).toBe('running');
  });
});

describe('findStructuralGaps', () => {
  // Real ids, because the agent id is what names the node and the extractor
  // requires that shape — short stand-ins would test a path production never takes.
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const nodes = [
    { id: 'root', title: 'Root', kind: 'component', parentId: null },
    { id: A, title: 'Alpha', kind: 'component', parentId: 'root' },
    { id: B, title: 'Beta', kind: 'component', parentId: 'root' },
    { id: D, title: 'A decision', kind: 'decision', parentId: 'root' },
  ];
  const P = { failure: 'plan patch not applied:', partial: 'plan patch partially applied:' };

  it('flags a childless component whose expansion was rejected', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'done',
          errorMessage: 'plan patch not applied: node not found',
        },
      ],
      P,
    );
    expect(gaps.map((g) => g.nodeId)).toEqual([A]);
  });

  it('flags a childless component whose terminal timed out', () => {
    // A partial wave can have successful siblings, so apply() degrades instead
    // of retrying the whole wave. If this agent also exhausts its per-agent
    // retry, coverage must preserve the missing parent as a known loss.
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'failed',
          errorMessage: 'CLI process exceeded its time budget (20m).',
        },
      ],
      P,
    );
    expect(gaps).toEqual([
      {
        nodeId: A,
        title: 'Alpha',
        reason: 'its decomposition terminal failed before producing children',
      },
    ]);
  });

  it('flags a failed bounded-continuation terminal', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-continue-b2-${A}-p4`,
          status: 'failed',
          errorMessage: 'CLI process exceeded its time budget (60m).',
        },
      ],
      P,
    );
    expect(gaps.map((gap) => gap.nodeId)).toEqual([A]);
  });

  it('does not mistake a clean atomic reply for a failed decomposition', () => {
    expect(
      findStructuralGaps(
        nodes,
        [{ agentId: `plan-expand-${A}-p1`, status: 'done', errorMessage: null }],
        P,
      ),
    ).toEqual([]);
  });

  it('does not preserve an older failure after a later clean retry', () => {
    expect(
      findStructuralGaps(
        nodes,
        [
          {
            agentId: `plan-expand-${A}-p1`,
            status: 'failed',
            errorMessage: 'CLI exited 1',
          },
          { agentId: `plan-expand-${A}-p2`, status: 'done', errorMessage: null },
        ],
        P,
      ),
    ).toEqual([]);
  });

  it('leaves an ordinary childless leaf alone', () => {
    // Most of a plan is leaves. Only one whose expansion was ATTEMPTED and lost
    // is suspect; flagging every leaf would report the plan itself.
    expect(findStructuralGaps(nodes, [], P)).toEqual([]);
  });

  it('never flags a decision, which is made rather than decomposed', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-expand-${D}-p1`,
          status: 'done',
          errorMessage: 'plan patch not applied: x',
        },
      ],
      P,
    );
    expect(gaps.map((g) => g.nodeId)).not.toContain(D);
  });

  it('reports a thinned decomposition even though the node has children', () => {
    const withKids = [...nodes, { id: 'c', title: 'Child', kind: 'component', parentId: A }];
    const gaps = findStructuralGaps(
      withKids,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'done',
          errorMessage: 'plan patch partially applied: link dropped: x',
        },
      ],
      P,
    );
    expect(gaps[0]?.reason).toContain('dropped');
  });

  it('does not report the same node twice', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'done',
          errorMessage: 'plan patch not applied: x',
        },
        {
          agentId: `plan-expand-${A}-p2`,
          status: 'done',
          errorMessage: 'plan patch partially applied: y',
        },
      ],
      P,
    );
    expect(gaps).toHaveLength(1);
  });
});

describe('not re-offering work already done', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nodes = [
    { id: 'root', title: 'Root', kind: 'component', parentId: null },
    { id: A, title: 'Alpha', kind: 'component', parentId: 'root' },
  ];
  const P = { failure: 'plan patch not applied:', partial: 'plan patch partially applied:' };

  it('drops an item a previous pass re-decomposed', () => {
    // The build's row still says "1 operation dropped" — that stays true after
    // the gap is filled — so without this the report re-offers finished work and
    // a second run grows the plan for nothing. MEASURED on a real task: 19
    // items before latest-attempt resolution, 0 after.
    expect(
      findStructuralGaps(
        nodes,
        [
          {
            agentId: `plan-expand-${A}-p1`,
            status: 'done',
            errorMessage: 'plan patch partially applied: one op dropped',
          },
          { agentId: `cover-node-${A}`, status: 'done', errorMessage: null },
        ],
        P,
      ),
    ).toEqual([]);
  });

  it('keeps a later failure visible after an earlier clean recovery', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `cover-node-${A}`,
          status: 'done',
          errorMessage: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          agentId: `plan-continue-b2-${A}-p1`,
          status: 'failed',
          errorMessage: 'CLI exited 1',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ],
      P,
    );
    expect(gaps.map((gap) => gap.nodeId)).toEqual([A]);
  });
});
