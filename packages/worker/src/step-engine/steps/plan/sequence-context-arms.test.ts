import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  computePlanSequence,
  loadPlanEdges,
  loadPlanSkeletons,
  planNodePath,
  sequenceAgentId,
  type PlanEdgeRecord,
  type PlanNodeSkeleton,
} from '@haive/shared/plan';
import {
  buildSequencePrompt,
  SEQUENCE_ROLE_OUTLINE_MAX_CHARS,
  computeTargets,
  planSequenceStep,
  sequenceForm,
  standalonePlanSequenceStep,
  type PlanSequenceDetect,
} from './03-plan-sequence.js';
import { MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import { buildPlanExpansionContext } from './_plan-expansion-context.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../_untrusted-repo.js';

vi.mock('@haive/shared/plan', async (original) => ({
  ...(await original<typeof import('@haive/shared/plan')>()),
  loadPlanEdges: vi.fn(),
  loadPlanSkeletons: vi.fn(),
}));

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function fixture(count = 6): PlanNodeSkeleton[] {
  const nodes: PlanNodeSkeleton[] = [];
  for (let i = 0; i < count; i++) {
    const parent = i === 0 ? undefined : nodes[i < 4 ? 0 : 1];
    nodes.push({
      id: id(i),
      parentId: parent?.id ?? null,
      path: planNodePath(parent?.path ?? null, id(i)),
      ordinal: i,
      title: `Part ${i} ${'context '.repeat(count > 6 ? 24 : 0)}`.trim(),
      kind: 'component',
      status: 'todo',
      taskable: i > 3,
      version: 1,
      createdBy: 'llm',
      sourceTaskId: null,
      lastReviewedAt: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
  }
  return nodes;
}
// Fourteen undecided runs: the root plus thirteen parents, all in stored order.
function manyTargets(): PlanNodeSkeleton[] {
  const root = fixture()[0]!;
  const nodes = [root];
  for (let i = 0; i < 13; i++) {
    const parent = {
      ...root,
      id: id(1 + i * 3),
      parentId: root.id,
      path: planNodePath(root.path, id(1 + i * 3)),
      ordinal: i,
    };
    nodes.push(parent);
    for (let j = 0; j < 2; j++) {
      nodes.push({
        ...parent,
        id: id(2 + i * 3 + j),
        parentId: parent.id,
        path: planNodePath(parent.path, id(2 + i * 3 + j)),
        ordinal: j,
      });
    }
  }
  return nodes;
}

const target = { parentId: id(1), parentTitle: 'Part 1', childCount: 2 };
function context(prompt: string): string {
  return prompt.split(`${UNTRUSTED_OPEN}\n`)[1]!.split(`\n${UNTRUSTED_CLOSE}`)[0]!;
}

beforeEach(() => vi.clearAllMocks());

describe('sequence context arms', () => {
  it('preserves the shipped parity prompt byte for byte, implicitly and explicitly', () => {
    const nodes = fixture();
    const order = computePlanSequence(nodes, []).sequenceById;
    const implicit = buildSequencePrompt(target, nodes, order);
    expect(implicit).toMatchSnapshot();
    expect(buildSequencePrompt(target, nodes, order, 'parity')).toBe(implicit);
  });

  it('caps only the outline, keeps the neighborhood and children, and states the trade-off', () => {
    const nodes = fixture(60);
    const order = computePlanSequence(nodes, []).sequenceById;
    const parity = buildSequencePrompt(target, nodes, order, 'parity');
    const role = buildSequencePrompt(target, nodes, order, 'role-sized');
    const heading = '## Whole-plan title index';
    expect(context(role).split(heading)[0]).toBe(context(parity).split(heading)[0]);
    expect(context(role).split(heading)[1]!.length + heading.length).toBeLessThanOrEqual(4_000);
    expect(context(parity).length - context(role).length).toBeGreaterThan(4_000);
    expect(role.split('## Your node')[1]).toBe(parity.split('## Your node')[1]);
    expect(context(role)).toMatch(/Showing \d+ evenly sampled title\(s\) from 60 nodes/);
    expect(role).toContain(
      `title outline at ${SEQUENCE_ROLE_OUTLINE_MAX_CHARS.toLocaleString('en-US')} characters`,
    );
    expect(role).toContain('Trade-off: nodes outside the neighborhood have');
    expect(role).toContain('cross-subtree `depends_on` links to them cannot be named directly.');
    for (const prompt of [parity, role]) {
      const shown = context(prompt);
      expect(shown).not.toMatch(/blocked by|depends_on|https?:|→/i);
      for (const line of shown.split('\n').filter((line) => /^\s*- /.test(line))) {
        expect(line).toMatch(/#\d+ /);
      }
    }
  });

  it('allows a small injectable outline bound without changing the neighborhood', () => {
    const nodes = fixture();
    const full = buildPlanExpansionContext(nodes, nodes[1]!);
    const small = buildPlanExpansionContext(nodes, nodes[1]!, undefined, { outlineMaxChars: 220 });
    const heading = '## Whole-plan title index';
    expect(small.split(heading)[0]).toBe(full.split(heading)[0]);
    expect(small.split(heading)[1]!.length + heading.length).toBeLessThanOrEqual(220);
    expect(small).toContain('evenly sampled title(s)');
  });
});

describe.each([planSequenceStep, standalonePlanSequenceStep])(
  '$metadata.id normal dispatch',
  (step) => {
    it('selects each arm from this task alone and defaults absent or unknown values to parity', async () => {
      const nodes = fixture();
      vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
      vi.mocked(loadPlanEdges).mockResolvedValue([]);
      const fake = createFakeDb({ tasks: schema.tasks });
      fake.insert(schema.tasks, { id: id(101), metadata: { sequenceContextArm: 'role-sized' } });
      fake.insert(schema.tasks, { id: id(102), metadata: {} });
      const detected: PlanSequenceDetect = {
        repositoryId: 'repo',
        nodeCount: nodes.length,
        ...computeTargets(nodes, [], new Set()),
        contradictoryRuns: 0,
        cycles: 0,
        ancestorDeps: 0,
        agentsUsed: 0,
        wave: 0,
        disagreements: [],
      };
      const order = computePlanSequence(nodes, []).sequenceById;
      for (const arm of [undefined, 'parity', 'role-sized', 'unknown']) {
        fake.patch(schema.tasks, id(102), { metadata: { sequenceContextArm: arm } });
        const dispatches = await step.agentMining!.selectAgents({
          ctx: { db: fake.db, taskId: id(102), logger: { warn: vi.fn() } },
          detected,
          formValues: {},
        } as never);
        expect(dispatches.length).toBeGreaterThan(0);
        for (const dispatch of dispatches) {
          const t = detected.targets.find(
            (t) => dispatch.agentTitle === `Order: ${t.parentTitle}`,
          )!;
          expect(dispatch.prompt).toBe(
            buildSequencePrompt(t, nodes, order, arm === 'role-sized' ? arm : 'parity'),
          );
          expect(dispatch.prompt.includes('This role-sized context caps the title outline')).toBe(
            arm === 'role-sized',
          );
        }
      }
    });
    it('preserves the task arm when apply dispatches a continuation wave', async () => {
      const nodes = fixture();
      vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
      vi.mocked(loadPlanEdges).mockResolvedValue([]);
      const fake = createFakeDb({
        tasks: schema.tasks,
        taskSteps: schema.taskSteps,
        taskStepAgentMinings: schema.taskStepAgentMinings,
      });
      fake.insert(schema.tasks, { id: id(102), metadata: { sequenceContextArm: 'role-sized' } });
      const detected: PlanSequenceDetect = {
        repositoryId: id(200),
        nodeCount: nodes.length,
        ...computeTargets(nodes, [], new Set()),
        contradictoryRuns: 0,
        cycles: 0,
        ancestorDeps: 0,
        agentsUsed: 0,
        wave: 0,
        disagreements: [],
      };
      // This fake deliberately supports only named joins; the empty asked-set reads are
      // irrelevant to this dispatch control, so fake them at the database seam.
      const db = {
        select(fields: Record<string, unknown>) {
          if ('metadata' in fields) return fake.db.select(fields as never);
          const empty = async () => [];
          return {
            from: () => ({
              where: empty,
              innerJoin: () => ({ innerJoin: () => ({ where: empty }) }),
            }),
          };
        },
      };
      let thrown: unknown;
      try {
        await step.apply(
          { db, taskId: id(102), taskStepId: id(103) } as never,
          { detected, formValues: {} } as never,
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MiningWaveError);
      expect((thrown as MiningWaveError).dispatches.length).toBeGreaterThan(0);
      for (const dispatch of (thrown as MiningWaveError).dispatches) {
        expect(dispatch.prompt).toContain('This role-sized context caps the title outline');
      }
    });

    it.each([undefined, 'parity', 'role-sized'])(
      'shows the detected context arm %s before budget approval',
      async (arm) => {
        const nodes = fixture();
        vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
        vi.mocked(loadPlanEdges).mockResolvedValue([]);
        const empty = async () => [];
        const ctx = {
          taskId: id(102),
          taskStepId: id(103),
          db: {
            query: {
              tasks: {
                findFirst: async () => ({
                  repositoryId: id(200),
                  metadata: { sequenceContextArm: arm, sequenceSingleWave: true },
                }),
              },
            },
            select: () => ({
              from: () => ({
                where: empty,
                innerJoin: () => ({ innerJoin: () => ({ where: empty }) }),
              }),
            }),
          },
        } as never;
        const detected = await step.detect!(ctx);
        expect(detected.contextArm).toBe(arm ?? 'parity');
        expect(sequenceForm(detected)?.description).toContain(`Context arm: ${arm ?? 'parity'}.`);
      },
    );

    it('warns once per task for an unknown stored arm across detection and repeated dispatch', async () => {
      const nodes = fixture();
      vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
      vi.mocked(loadPlanEdges).mockResolvedValue([]);
      const fake = createFakeDb({ tasks: schema.tasks });
      const taskId = step.metadata.workflowType === 'plan_build' ? id(301) : id(302);
      const metadata = { sequenceContextArm: 'future-arm' };
      fake.insert(schema.tasks, { id: taskId, metadata });
      const warn = vi.fn();
      const empty = async () => [];
      const ctx = {
        taskId,
        taskStepId: id(103),
        logger: { warn },
        db: {
          query: { tasks: { findFirst: async () => ({ repositoryId: id(200), metadata }) } },
          select(fields: Record<string, unknown>) {
            if ('metadata' in fields) return fake.db.select(fields as never);
            return {
              from: () => ({
                where: empty,
                innerJoin: () => ({ innerJoin: () => ({ where: empty }) }),
              }),
            };
          },
        },
      } as never;
      const detected = await step.detect!(ctx);
      expect(warn).toHaveBeenCalledOnce();
      expect(detected.contextArm).toBe('parity');
      expect(sequenceForm(detected)?.description).toContain('Context arm: parity.');
      for (let i = 0; i < 2; i++) {
        const dispatches = await step.agentMining!.selectAgents({
          ctx,
          detected,
          formValues: {},
        } as never);
        for (const dispatch of dispatches) {
          expect(dispatch.prompt).not.toContain('This role-sized context');
        }
        await step.detect!(ctx);
      }
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        { taskId, contextArm: 'parity' },
        'Unknown stored sequence context arm; using parity',
      );
    });

    it('dispatches exactly twelve of more than twelve targets for the first single wave', async () => {
      const nodes = manyTargets();
      vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
      vi.mocked(loadPlanEdges).mockResolvedValue([]);
      const fake = createFakeDb({ tasks: schema.tasks });
      fake.insert(schema.tasks, { id: id(102), metadata: { sequenceSingleWave: true } });
      const targets = computeTargets(nodes, [], new Set()).targets;
      expect(targets.length).toBeGreaterThanOrEqual(13);
      const dispatches = await step.agentMining!.selectAgents({
        ctx: { db: fake.db, taskId: id(102) },
        detected: { repositoryId: id(200), targets, agentsUsed: 0, singleWave: true, wave: 0 },
        formValues: {},
      } as never);
      expect(dispatches).toHaveLength(12);
      expect(dispatches.map((d) => d.agentId)).toEqual(
        targets.slice(0, 12).map((t) => sequenceAgentId(t.parentId, 1)),
      );
    });

    it.each([false, true])(
      'ends apply at twelve agents with pending targets (disagreement: %s)',
      async (disagrees) => {
        const nodes = manyTargets();
        const targets = computeTargets(nodes, [], new Set()).targets;
        const rows = targets.slice(0, 12).map((t) => ({
          agentId: sequenceAgentId(t.parentId, 1),
          taskStepId: id(103),
          status: 'done',
          rawOutput: null,
          output: {
            ops:
              t.parentId === id(1)
                ? [
                    { op: 'upsert', nodeRef: id(2), ordinal: 1 },
                    { op: 'upsert', nodeRef: id(3), ordinal: 0 },
                  ]
                : [],
            summary: 'independent order',
          },
        }));
        const edges: PlanEdgeRecord[] = disagrees
          ? [
              {
                id: id(500),
                fromNodeId: id(3),
                toNodeId: id(2),
                kind: 'depends_on',
                note: 'Recorded opposite order',
              },
            ]
          : [];
        vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
        vi.mocked(loadPlanEdges).mockResolvedValue(edges);
        const ctx = {
          taskId: id(102),
          taskStepId: id(103),
          db: {
            query: {
              tasks: {
                findFirst: async () => ({
                  repositoryId: id(200),
                  metadata: { sequenceSingleWave: true },
                }),
              },
            },
            // Named joins are not supported by FakeDb. Both reads use the same
            // planted mining rows: this step's count and the repository's asked-set.
            select: () => ({
              from: () => ({
                where: async () => rows,
                innerJoin: () => ({ innerJoin: () => ({ where: async () => rows }) }),
              }),
            }),
          },
        } as never;
        const detected = await step.detect!(ctx);
        expect(detected.agentsUsed).toBe(12);
        expect(detected.targets.length).toBeGreaterThanOrEqual(1);
        const applied = step.apply(ctx, {
          detected: { ...detected, disagreements: [] },
          formValues: {},
        } as never);
        if (disagrees) {
          await expect(applied).rejects.toBeInstanceOf(ReopenStepFormError);
          const refreshed = await step.detect!(ctx);
          expect(refreshed.targets.length).toBeGreaterThanOrEqual(1);
          expect(refreshed.disagreements).toHaveLength(1);
          expect(sequenceForm(refreshed)?.title).toBe(
            'Dependencies a second opinion disagreed with',
          );
        } else {
          // A fulfilled apply also proves it threw neither MiningWaveError nor any other error.
          const result = await applied;
          expect(result.dispatched).toBe(0);
          expect(result.remaining).toBeGreaterThanOrEqual(1);
          expect(result.decision).toBe('sequenced');
        }
      },
    );
    it('hydrates the one-wave budget and caps selection and the review form at twelve agents', async () => {
      const nodes = fixture();
      vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
      vi.mocked(loadPlanEdges).mockResolvedValue([]);
      const fake = createFakeDb({ tasks: schema.tasks });
      fake.insert(schema.tasks, { id: id(102), metadata: { sequenceSingleWave: true } });
      const db = {
        query: {
          tasks: {
            findFirst: async () => ({
              repositoryId: id(200),
              metadata: { sequenceSingleWave: true },
            }),
          },
        },
        select(fields: Record<string, unknown>) {
          if ('metadata' in fields) return fake.db.select(fields as never);
          const empty = async () => [];
          return {
            from: () => ({
              where: empty,
              innerJoin: () => ({ innerJoin: () => ({ where: empty }) }),
            }),
          };
        },
      };
      const ctx = { db, taskId: id(102), taskStepId: id(103) } as never;
      const detected = await step.detect!(ctx);
      expect(detected.singleWave).toBe(true);
      expect(sequenceForm(detected)?.description).toContain('This pilot stops after one wave');
      expect(
        await step.agentMining!.selectAgents({
          ctx,
          detected: { ...detected, agentsUsed: 12 },
          formValues: {},
        } as never),
      ).toEqual([]);
      const disagreement = {
        edgeId: 'e',
        fromNodeId: id(4),
        toNodeId: id(5),
        fromTitle: 'A',
        toTitle: 'B',
        note: null,
      };
      expect(
        sequenceForm({ ...detected, agentsUsed: 12, disagreements: [disagreement] })?.title,
      ).toBe('Dependencies a second opinion disagreed with');
    });
  },
);
