import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { loadPlanSkeletons, type PlanNodeSkeleton } from '@haive/shared/plan';
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
import type { PlanInputRow, PlanInputsApply } from './00-plan-inputs.js';
import type { FormSchema } from '@haive/shared';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { MiningWaveError } from '../../step-definition.js';

// A structural repair reads its node's live neighbourhood when it is dispatched.
// Empty unless a case supplies one, which leaves every repair on the listing it
// always had.
vi.mock('@haive/shared/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/plan')>();
  return {
    ...actual,
    loadPlanSkeletons: vi.fn(async () => []),
    // A plan whose render only fits the budget at depth 1, so the ladder in
    // renderBoundedPlanIndex has to step down for a section repair to read it.
    renderPlanMarkdown: vi.fn(
      async (_db: unknown, _repositoryId: string, opts: { maxDepth?: number } = {}) =>
        renderedPlan({ 3: 900, 2: 600, 1: 300 }[opts.maxDepth ?? 3] ?? 300),
    ),
  };
});

/** Shaped like `renderPlanMarkdown`'s titles-only output: a heading per node and
 *  an attrs line carrying its ref, which is what a truncating slice used to cut. */
function renderedPlan(nodes: number): string {
  return Array.from({ length: nodes }, (_, index) => {
    const id = `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    return `## ${index + 1}. Component number ${index} with a reasonably long title\n\`node:${id}\` · \`component\` · \`todo\`\n`;
  }).join('\n');
}

type Detected = Parameters<NonNullable<typeof planCoverageStep.form>>[1];

const detected = (over: Partial<Detected> = {}): Detected =>
  ({
    repositoryId: 'r1',
    structural: [],
    sections: [],
    sectionBodies: {},
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
    const applyError = await planCoverageStep.apply!(attachedCtx([]), {
      detected: detected({
        buildFormValues: { depthBudget: 6, breadthCap: 7 },
        structural: [{ nodeId: TARGET, title: 'Privacy', reason: 'lost' }],
      }),
      formValues: { decision: 'redecompose', items: [`node:${TARGET}`] },
    } as never).catch((error: unknown) => error);

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

  it('counts a node:-prefixed parent against the children it already has', () => {
    // The applier strips the prefix later, so the guard used to see a parent of
    // its own with nothing under it.
    const ops = [create('tmp-a', `node:${TARGET}`), create('tmp-b', `node:${TARGET}`)];
    expect(
      findPatchBreadthViolations(ops, 12, { existingChildren: new Map([[TARGET, 11]]) }),
    ).toEqual([{ parentRef: TARGET, existingChildren: 11, newChildren: 2, totalChildren: 13 }]);
  });

  it('does not count an existing node as a new child because it carries the prefix', () => {
    // A uuid names a node that already exists, so it takes no new slot — and
    // neither does the same uuid quoted as `node:<uuid>`.
    const EXISTING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ops = Array.from({ length: 12 }, (_, index) => create(`tmp-${index}`, 'self'));
    ops.push(create(`node:${EXISTING}`, 'self'));
    expect(findPatchBreadthViolations(ops, 12, { selfNodeId: TARGET })).toEqual([]);
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

const TASK = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000a1';

/** A stable uuid per name, so a recorded input and a live row can name the same attachment. */
const idOf = (name: string): string => {
  const h = createHash('md5').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** A step context on the in-memory database whose task has exactly these attachments, and whose
 *  `00-plan-inputs` recorded `recorded`. The rows have no files behind them, so none of them is
 *  prepared again and each counts by its kind alone. The mining-row read is a join the fake cannot
 *  run, so it answers that no agent has run yet. */
const attachedCtx = (
  rows: (string | { id: string; filename: string })[],
  recorded: (Partial<PlanInputRow> & { filename: string })[] = [],
  opts: { repoPath?: string; attachmentsUnreadable?: boolean } = {},
) => {
  const repoPath = opts.repoPath ?? '/nowhere';
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskAttachments: schema.taskAttachments,
    taskSteps: schema.taskSteps,
    planNodes: schema.planNodes,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: '00000000-0000-4000-8000-0000000000f1',
    type: 'plan_build',
    title: 'plan',
  });
  for (const x of rows) {
    const row = typeof x === 'string' ? { id: idOf(x), filename: x } : x;
    fake.insert(schema.taskAttachments, {
      ...row,
      taskId: TASK,
      userId: USER,
      storedPath: `${repoPath}/.haive/task-uploads/${TASK}/${row.filename}`,
      sizeBytes: 1,
    });
  }
  const inputs: PlanInputRow[] = recorded.map((r) => ({
    kind: 'text',
    bytes: 1,
    description: null,
    sidecar: null,
    hasText: (r.kind ?? 'text') === 'text',
    note: null,
    ...r,
  }));
  const output: PlanInputsApply = {
    inputs,
    extracted: 0,
    unreadable: [],
    hasImageInputs: inputs.some((i) => i.kind === 'image'),
    hasPdfInputs: inputs.some((i) => i.kind === 'pdf'),
    visualOnly: [],
    indexPath: null,
    archiveNotes: [],
  };
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '00-plan-inputs',
    stepIndex: -1,
    title: 'Prepare the inputs',
    status: 'done',
    output,
  });
  const db = {
    ...fake.db,
    select: (fields?: never) => ({
      from: (table: never) => {
        if (table === schema.taskStepAgentMinings) {
          return { innerJoin: () => ({ leftJoin: () => ({ where: async () => [] }) }) };
        }
        if (table === schema.taskAttachments && opts.attachmentsUnreadable) {
          throw new Error('connection lost');
        }
        return fake.db.select(fields).from(table);
      },
    }),
  };
  return {
    taskId: TASK,
    repoPath,
    db,
    logger: { warn() {}, info() {} },
    emitProgress: async () => {},
  } as never;
};

describe('the structural repair prompt', () => {
  const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const node = (id: string, title: string, parentId: string | null, path: string) =>
    ({
      id,
      parentId,
      path,
      ordinal: 0,
      title,
      kind: 'component',
      status: 'todo',
      taskable: false,
      version: 1,
      createdBy: 'llm',
      sourceTaskId: null,
      lastReviewedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }) satisfies PlanNodeSkeleton;
  const root = node('root', 'Product', null, '/root/');
  const plan = (children: number) => [
    root,
    node(TARGET, 'Privacy', 'root', `/root/${TARGET}/`),
    ...Array.from({ length: children }, (_, index) =>
      node(`child-${index}`, `Existing part ${index}`, TARGET, `/root/${TARGET}/child-${index}/`),
    ),
  ];

  const promptFor = async (items: string[], over: Partial<Detected> = {}) => {
    const error = await planCoverageStep.apply!(attachedCtx(['spec.md']), {
      detected: detected({
        structural: [{ nodeId: TARGET, title: 'Privacy', reason: 'lost' }],
        ...over,
      }),
      formValues: { decision: 'redecompose', items },
    } as never).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MiningWaveError);
    return (error as MiningWaveError).dispatches[0]!.prompt;
  };
  const repairOf = async (children: number, over: Partial<Detected> = {}) => {
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce(plan(children));
    return promptFor([`node:${TARGET}`], over);
  };

  it('tells the repair of a childless node that it has no children', async () => {
    expect(await repairOf(0)).toContain('it currently has no children');
  });

  it('shows a thinned node its existing children and the room left under the cap', async () => {
    // MEASURED: every repair refused over the cap was told "no children" while
    // its node had 7-19, and re-added the same subtree.
    const prompt = await repairOf(8);
    expect(prompt).not.toContain('currently has no children');
    expect(prompt).toContain('It already has 8 direct child(ren)');
    expect(prompt).toContain('At most 4 more direct child(ren) fit under it (the limit is 12)');
    for (let index = 0; index < 8; index += 1) {
      expect(prompt).toContain(`Existing child: Existing part ${index}`);
    }
    // The head of the whole-plan listing showed the node to 1 of those 9 repairs.
    expect(prompt).not.toContain('The plan as it stands (titles only):');
  });

  it('tells a node already past the cap to add nothing directly under it', async () => {
    const prompt = await repairOf(19);
    expect(prompt).toContain('add nothing directly under it');
    expect(prompt).not.toContain('fit under it (the limit');
  });

  it('quotes what the previous attempt lost', async () => {
    const lost = `breadth cap 12 exceeded (${TARGET}: 0 existing + 13 new = 13)`;
    const prompt = await repairOf(0, {
      structural: [{ nodeId: TARGET, title: 'Privacy', reason: 'lost', detail: lost }],
    });
    expect(prompt).toContain(`What the previous attempt lost: ${lost}`);
  });

  it('keeps the plan listing for a node deleted since detect', async () => {
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([root]);
    const prompt = await promptFor([`node:${TARGET}`]);
    expect(prompt).toContain('The plan as it stands (titles only):');
    expect(prompt).toContain('it currently has no children');
  });

  it('keeps the plan listing for a document section, which names no node', async () => {
    vi.mocked(loadPlanSkeletons).mockClear();
    const prompt = await promptFor(['doc:spec.md:12'], {
      structural: [],
      sections: [
        {
          source: 'spec.md',
          line: 12,
          title: 'Billing',
          score: 0,
          matchedNodes: 0,
          missingTerms: ['x'],
        },
      ],
    });
    expect(prompt).toContain('The plan as it stands (titles only):');
    // No structural item was picked, so no node neighbourhood is read.
    expect(loadPlanSkeletons).not.toHaveBeenCalled();
  });

  it('gives a section repair a depth-bounded index rather than a slice', async () => {
    const prompt = await promptFor(['doc:spec.md:12'], {
      structural: [],
      sections: [
        {
          source: 'spec.md',
          line: 12,
          title: 'Billing',
          score: 0,
          matchedNodes: 0,
          missingTerms: ['x'],
        },
      ],
    });
    // The ladder stepped down to the depth that fits, and says so rather than
    // letting the agent read a partial plan as the whole one.
    expect(prompt).toContain('bounded to 1 level(s) of the plan');
    expect(prompt).toContain('do not invent an id for one you cannot see');
    // Every ref survives whole: a character slice could leave half a uuid, which
    // the agent would quote back as if it were a node.
    const refs = prompt.match(/node:[0-9a-f-]+/g) ?? [];
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.every((ref) => ref.length === 'node:'.length + 36)).toBe(true);
  });
});

describe('a repair picked from a document deleted since the gate drafted it', () => {
  const section = (source: string, line: number) => ({
    source,
    line,
    title: `Section ${line}`,
    score: 0,
    matchedNodes: 0,
    missingTerms: ['x'],
  });
  const d = detected({
    structural: [],
    sections: [section('spec.md', 12), section('old.md', 4)],
    sectionBodies: { 'doc:spec.md:12': 'Billing runs monthly.', 'doc:old.md:4': 'Retired text.' },
    docNames: ['spec.md', 'old.md'],
  });

  it('never sends the deleted document’s section, whose body the gate still holds', async () => {
    const error = await planCoverageStep.apply!(attachedCtx(['spec.md']), {
      detected: d,
      formValues: { decision: 'redecompose', items: ['doc:spec.md:12', 'doc:old.md:4'] },
    } as never).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MiningWaveError);
    const prompts = (error as MiningWaveError).dispatches.map((x) => x.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Billing runs monthly.');
    expect(prompts.join('\n')).not.toContain('Retired text.');
  });

  it('never sends a section drafted from a document since replaced under the same name', async () => {
    // `spec.md` was deleted and re-uploaded: the gate still holds the OLD body under that name.
    const error = await planCoverageStep.apply!(
      attachedCtx(
        [{ id: idOf('new spec.md'), filename: 'spec.md' }, 'old.md'],
        [
          { id: idOf('first spec.md'), filename: 'spec.md' },
          { id: idOf('old.md'), filename: 'old.md' },
        ],
      ),
      {
        detected: d,
        formValues: { decision: 'redecompose', items: ['doc:spec.md:12', 'doc:old.md:4'] },
      } as never,
    ).catch((err: unknown) => err);
    const prompts = (error as MiningWaveError).dispatches.map((x) => x.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Retired text.');
    expect(prompts.join('\n')).not.toContain('Billing runs monthly.');
  });

  it('drops a section by the row it was read from, even once a same-named replacement is recorded', async () => {
    // Looked up by name, the recorded replacement would answer for the deleted document, and the
    // body the gate still holds would go to an agent.
    const first = idOf('first spec.md');
    const replacement = idOf('new spec.md');
    const drafted = detected({
      sections: [
        { ...section('spec.md', 12), sourceId: first },
        { ...section('old.md', 4), sourceId: idOf('old.md') },
      ],
      sectionBodies: d.sectionBodies,
      docNames: d.docNames,
    });
    const error = await planCoverageStep.apply!(
      attachedCtx(
        [{ id: replacement, filename: 'spec.md' }, 'old.md'],
        [
          { id: replacement, filename: 'spec.md' },
          { id: idOf('old.md'), filename: 'old.md' },
        ],
      ),
      {
        detected: drafted,
        formValues: { decision: 'redecompose', items: ['doc:spec.md:12', 'doc:old.md:4'] },
      } as never,
    ).catch((err: unknown) => err);
    const prompts = (error as MiningWaveError).dispatches.map((x) => x.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Retired text.');
    expect(prompts.join('\n')).not.toContain('Billing runs monthly.');
  });

  it('keeps every picked section when the attachments cannot be read', async () => {
    // Shaped like a drizzle builder, which is awaitable AND carries `.limit`: an async `where` would
    // hand the `.limit` caller a rejected promise nobody awaits.
    const lost = () => new Error('connection lost');
    const unreadable = {
      taskId: 't1',
      logger: { warn() {}, info() {} },
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                throw lost();
              },
              then: (_resolve: unknown, reject: (err: Error) => void) => reject(lost()),
            }),
          }),
        }),
      },
    } as never;
    const error = await planCoverageStep.apply!(unreadable, {
      detected: d,
      formValues: { decision: 'redecompose', items: ['doc:spec.md:12', 'doc:old.md:4'] },
    } as never).catch((err: unknown) => err);
    expect((error as MiningWaveError).dispatches).toHaveLength(2);
  });

  it('has nothing to repair when every picked section came from deleted documents', async () => {
    const out = await planCoverageStep.apply!(attachedCtx(['spec.md']), {
      detected: d,
      formValues: { decision: 'redecompose', items: ['doc:old.md:4'] },
    } as never);
    expect(out.decision).toBe('accepted');
  });
});

describe('the sections the gate drafts', () => {
  const NODE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const privacy = {
    id: NODE,
    parentId: null,
    path: `/${NODE}/`,
    ordinal: 0,
    title: 'Privacy',
    kind: 'component',
    status: 'todo',
    taskable: true,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: null,
    lastReviewedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies PlanNodeSkeleton;
  /** A repository holding these attached files, under the uploads directory the rows name. */
  const repoWith = async (files: Record<string, string>) => {
    const repo = await mkdtemp(path.join(tmpdir(), 'haive-coverage-'));
    const uploads = path.join(repo, '.haive', 'task-uploads', TASK);
    await mkdir(uploads, { recursive: true });
    for (const [name, text] of Object.entries(files))
      await writeFile(path.join(uploads, name), text);
    return repo;
  };

  it('reads a document attached after the inputs were prepared, and names its row', async () => {
    const repo = await repoWith({ 'late.md': '## Billing\nMonthly invoices.\n' });
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([privacy]);
    const d = await planCoverageStep.detect!(attachedCtx(['late.md'], [], { repoPath: repo }));
    expect(d.sections).toMatchObject([
      { title: 'Billing', source: 'late.md', sourceId: idOf('late.md') },
    ]);
    await rm(repo, { recursive: true, force: true });
  });

  it('says the scan cannot see a picture attached since, even one nobody could prepare', async () => {
    const repo = await repoWith({ 'late.md': '## Billing\nMonthly invoices.\n' });
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([privacy]);
    const d = await planCoverageStep.detect!(
      attachedCtx(['late.md', 'shot.png'], [], { repoPath: repo }),
    );
    expect(d.hasVisualInputs).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });

  it('drafts from the recorded inputs when the attachments cannot be read', async () => {
    const repo = await repoWith({ 'spec.md': '## Billing\nMonthly invoices.\n' });
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([privacy]);
    const d = await planCoverageStep.detect!(
      attachedCtx(['spec.md'], [{ id: idOf('spec.md'), filename: 'spec.md' }], {
        repoPath: repo,
        attachmentsUnreadable: true,
      }),
    );
    expect(d.sections).toMatchObject([{ title: 'Billing', sourceId: idOf('spec.md') }]);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('what every coverage agent has to be able to see', () => {
  // The builder's own rule, applied to what is attached NOW: no coverage dispatch set it before, so a
  // wireframe never forced vision on a coverage agent.
  const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const leaf = {
    id: TARGET,
    parentId: null,
    path: `/${TARGET}/`,
    ordinal: 0,
    title: 'Privacy',
    kind: 'component',
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: null,
    lastReviewedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies PlanNodeSkeleton;
  const picture = () =>
    attachedCtx(['wire.png'], [{ id: idOf('wire.png'), filename: 'wire.png', kind: 'image' }]);
  const repair = async (ctx: never) => {
    const error = await planCoverageStep.apply!(ctx, {
      detected: detected({ structural: [{ nodeId: TARGET, title: 'Privacy', reason: 'lost' }] }),
      formValues: { decision: 'redecompose', items: [`node:${TARGET}`] },
    } as never).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MiningWaveError);
    return (error as MiningWaveError).dispatches;
  };

  it('requires vision of a repair agent when a picture is attached', async () => {
    const dispatches = await repair(picture());
    expect(dispatches.map((x) => x.capabilities)).toEqual([['tool_use', 'vision']]);
  });

  it('prefers a model that can see for a PDF, without requiring one', async () => {
    const dispatches = await repair(
      attachedCtx(
        ['spec.pdf'],
        [
          {
            id: idOf('spec.pdf'),
            filename: 'spec.pdf',
            kind: 'pdf',
            sidecar: 'spec.pdf.extracted.md',
            hasText: true,
          },
        ],
      ),
    );
    expect(dispatches[0]).toMatchObject({ capabilities: ['tool_use'], preferVision: true });
  });

  it('counts a picture nobody could prepare by its kind', async () => {
    const dispatches = await repair(attachedCtx(['late.png']));
    expect(dispatches[0]?.capabilities).toEqual(['tool_use', 'vision']);
  });

  it('requires it of a convergence wave the gate dispatches', async () => {
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([leaf]);
    const error = await planCoverageStep.apply!(picture(), {
      detected: detected({ frontierRemaining: 1 }),
      formValues: { decision: 'converge' },
    } as never).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MiningWaveError);
    expect((error as MiningWaveError).dispatches.map((x) => x.capabilities)).toEqual([
      ['tool_use', 'vision'],
    ]);
  });

  it('requires it of the first convergence wave too', async () => {
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce([leaf]);
    const dispatches = await planCoverageStep.agentMining!.selectAgents({
      ctx: picture(),
      detected: detected({ frontierRemaining: 1 }),
      formValues: { decision: 'converge' },
    } as never);
    expect(dispatches.map((x) => x.capabilities)).toEqual([['tool_use', 'vision']]);
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
    expect(gaps[0]?.detail).toBe('link dropped: x');
  });

  it('carries what a rejected expansion lost, without the stamp prefix', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'done',
          errorMessage: 'plan patch not applied: breadth cap 12 exceeded (x)',
        },
      ],
      P,
    );
    expect(gaps[0]?.detail).toBe('breadth cap 12 exceeded (x)');
  });

  it('offers again a node with children whose latest repair was refused', () => {
    // The measured case: a repair of a thinned node, refused over the breadth
    // cap. The childless rule cannot see it, so it used to drop off the gate.
    const refusal = `breadth cap 12 exceeded (${A}: 8 existing + 8 new = 16)`;
    const withKids = [...nodes, { id: 'c', title: 'Child', kind: 'component', parentId: A }];
    const gaps = findStructuralGaps(
      withKids,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          status: 'done',
          errorMessage: 'plan patch partially applied: link dropped: x',
        },
        {
          agentId: `cover-node-${A}-r1`,
          status: 'done',
          errorMessage: `plan patch not applied: ${refusal}`,
        },
      ],
      P,
    );
    expect(gaps).toEqual([
      {
        nodeId: A,
        title: 'Alpha',
        reason: 'its latest decomposition attempt was rejected',
        detail: refusal,
      },
    ]);
  });

  it('does not offer a node with children once its latest repair landed', () => {
    const withKids = [...nodes, { id: 'c', title: 'Child', kind: 'component', parentId: A }];
    expect(
      findStructuralGaps(
        withKids,
        [
          {
            agentId: `plan-expand-${A}-p1`,
            status: 'done',
            errorMessage: 'plan patch not applied: x',
          },
          { agentId: `cover-node-${A}-r1`, status: 'done', errorMessage: null },
        ],
        P,
      ),
    ).toEqual([]);
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

describe('re-offering a gap the gate already tried', () => {
  const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SECOND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const dispatchIds = async (over: Partial<Detected>, items: string[], exhausted = false) => {
    const error = await planCoverageStep.apply!(attachedCtx(['spec.md']), {
      detected: detected(over),
      formValues: { decision: 'redecompose', items },
      ...(exhausted ? { miningWaveExhausted: true } : {}),
    } as never).catch((err: unknown) => err);
    return error;
  };

  const gap = (nodeId: string) => ({ nodeId, title: nodeId, reason: 'lost' });
  const section = (line: number) => ({
    source: 'spec.md',
    line,
    title: `section ${line}`,
    score: 0,
    matchedNodes: 0,
    missingTerms: ['x'],
  });

  it('numbers a never-attempted gap as the first round', async () => {
    const error = await dispatchIds({ structural: [gap(TARGET)] }, [`node:${TARGET}`]);
    expect(error).toBeInstanceOf(MiningWaveError);
    expect((error as MiningWaveError).dispatches.map((d) => d.agentId)).toEqual([
      `cover-node-${TARGET}-r1`,
    ]);
  });

  // The failure this scoping exists for: a repair agent finished but its patch
  // was dropped, so the gap stood and the gate re-offered it. Re-using the first
  // attempt's id hit the unique (task_step_id, agent_id) index, every dispatch
  // was skipped as a duplicate, and the step failed with the wave's own message.
  it('gives a re-offered gap a fresh id rather than the one that failed it', async () => {
    const error = await dispatchIds(
      {
        structural: [gap(TARGET)],
        manualRounds: { [`cover-node-${TARGET}`]: 1 },
      },
      [`node:${TARGET}`],
    );
    expect((error as MiningWaveError).dispatches[0]?.agentId).toBe(`cover-node-${TARGET}-r2`);
  });

  it('counts each gap separately', async () => {
    const error = await dispatchIds(
      {
        structural: [gap(TARGET), gap(SECOND)],
        sections: [section(1784)],
        manualRounds: { [`cover-node-${TARGET}`]: 2 },
      },
      [`node:${TARGET}`, `node:${SECOND}`, 'doc:spec.md:1784'],
    );
    expect((error as MiningWaveError).dispatches.map((d) => d.agentId)).toEqual([
      `cover-node-${TARGET}-r3`,
      `cover-node-${SECOND}-r1`,
      'cover-doc-spec-md-1784-r1',
    ]);
  });

  it('tolerates a detect snapshot written before rounds existed', async () => {
    // `detect_output` is persisted JSON, so a step already in flight when this
    // shipped is retried against a snapshot with no `manualRounds` field.
    const error = await dispatchIds({ structural: [gap(TARGET)], manualRounds: undefined }, [
      `node:${TARGET}`,
    ]);
    expect((error as MiningWaveError).dispatches[0]?.agentId).toBe(`cover-node-${TARGET}-r1`);
  });

  // Asking twice makes the runner fall through to the generic failure handler,
  // which stamps the wave's message as the step error — a status line naming no
  // cause. Say what actually happened instead.
  it('does not ask for a second wave the runner already said is not coming', async () => {
    const error = await dispatchIds({ structural: [gap(TARGET)] }, [`node:${TARGET}`], true);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MiningWaveError);
    expect((error as Error).message).toContain('could not dispatch a CLI agent');
    expect((error as Error).message).toContain('1 selected gap');
  });

  it('still resolves a round-scoped recovery id back to its focus node', async () => {
    // The scan's attempt regex is anchored; an id it cannot parse drops out of
    // the attempt map entirely, which reads as "never attempted".
    const blocked = unresolvedExpansionNodeIds([
      { agentId: `cover-node-${TARGET}-r1`, status: 'failed', errorMessage: 'CLI exited 1' },
    ]);
    expect(blocked.has(TARGET)).toBe(true);
  });

  it('lets a later round supersede an earlier one', async () => {
    const blocked = unresolvedExpansionNodeIds([
      { agentId: `cover-node-${TARGET}-r1`, status: 'failed', errorMessage: 'CLI exited 1' },
      { agentId: `cover-node-${TARGET}-r2`, status: 'done', errorMessage: null },
    ]);
    expect(blocked.has(TARGET)).toBe(false);
  });
});
