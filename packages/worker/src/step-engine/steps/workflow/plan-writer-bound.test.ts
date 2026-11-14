import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  applyPlanPatch,
  PlanPatchError,
  renderPlanMarkdownFrom,
  type PlanNodeRecord,
} from '@haive/shared/plan';
import { planReconcileStep } from './11f-plan-reconcile.js';
import { externalPlanSyncStep } from './01f-external-plan-sync.js';
import { renderBoundedPlanIndexParts } from '../plan/_plan-index.js';
import { PLAN_EXPANSION_CONTEXT_MAX_CHARS } from '../plan/_plan-expansion-context.js';
import { PLAN_CHAT_SNAPSHOT_PATH } from '../../../plan/chat-snapshot-contract.js';
import { runInSandbox } from '../../../sandbox/sandbox-runner.js';
import type { DockerRunner, DockerRunOpts } from '../../../sandbox/docker-runner.js';

vi.mock('@haive/shared/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/plan')>()),
  applyPlanPatch: vi.fn(),
}));
vi.mock('../../../plan/mirror.js', () => ({ writePlanMirror: vi.fn() }));
vi.mock('./_external-drift.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_external-drift.js')>()),
  resolveExternalDrift: vi.fn(),
  stampExternalWatermark: vi.fn(),
}));
import { boundedPlanWriterPrompt, PlanFocusTooLargeError } from './_plan-ops.js';
import { renderBoundedPlanOutline } from '../plan/_plan-index.js';
import { stampExternalWatermark } from './_external-drift.js';

const node = (i: number, parentId: string | null = null): PlanNodeRecord => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  parentId,
  path: '',
  ordinal: i,
  title: `Component ${i}`,
  kind: 'component',
  status: 'todo',
  taskable: false,
  version: i + 1,
  body: `Whole body ${i}`,
  createdBy: 'user',
  sourceTaskId: null,
  lastReviewedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
function fixture(count = 8) {
  const root = node(0);
  root.path = `/${root.id}/`;
  const nodes = [
    root,
    ...Array.from({ length: count - 1 }, (_, i) => {
      const n = node(i + 1, root.id);
      n.path = `${root.path}${n.id}/`;
      return n;
    }),
  ];
  return { nodes, edges: [], codeLinks: [] as { nodeId: string; repoPath: string }[] };
}
function detected(read = fixture()) {
  return {
    repositoryId: 'repo',
    planRead: read,
    planMarkdown: renderPlanMarkdownFrom(read.nodes, read.edges, { withVersions: true }),
    spec: '',
    affected: [],
    changedPaths: ['src/changed.ts'],
    nodeTitles: Object.fromEntries(read.nodes.map((n) => [n.id, n.title])),
    nodeCount: read.nodes.length,
    branchPoint: 'a'.repeat(40),
    since: 'b'.repeat(40),
    firstRun: false,
    measured: true,
    commits: [{ sha: 'a'.repeat(40), subject: 'change' }],
    commitsOmitted: 0,
    pathsOmitted: 0,
    reason: null,
    linksMarkedStale: 0,
  };
}

it('keeps depth four when it fits without changing the default depth three', () => {
  const read = fixture(1);
  for (let i = 1; i <= 4; i++) {
    const parent = read.nodes.at(-1)!;
    const n = node(i, parent.id);
    n.path = `${parent.path}${n.id}/`;
    read.nodes.push(n);
  }
  const render = renderBoundedPlanIndexParts as (...args: unknown[]) => { text: string };
  expect(render(read, '', 10_000, 4).text).toContain(read.nodes[4]!.id);
  expect(render(read, '', 10_000).text).not.toContain(read.nodes[4]!.id);
});

it('bounds the entire 800-node 11f prompt and gives every shown ref its read version', () => {
  const read = fixture(800);
  for (const n of read.nodes) {
    n.title += ' long title'.repeat(30);
    n.body = 'body'.repeat(100);
  }
  const prompt = planReconcileStep.llm!.buildPrompt({
    detected: detected(read),
  } as never) as string;
  expect(PLAN_EXPANSION_CONTEXT_MAX_CHARS).toBe(96_000);
  expect(prompt.length).toBeLessThanOrEqual(PLAN_EXPANSION_CONTEXT_MAX_CHARS);
  for (const n of read.nodes)
    if (prompt.includes(`node:${n.id}`)) expect(prompt).toContain(`version ${n.version}`);
  expect(prompt).toContain(PLAN_CHAT_SNAPSHOT_PATH);
});

it.each([planReconcileStep, externalPlanSyncStep])(
  'keeps a changed-path focus whole beyond index depth ($metadata.id)',
  (step) => {
    const read = fixture(1);
    for (let i = 1; i <= 5; i++) {
      const parent = read.nodes.at(-1)!;
      const n = node(i, parent.id);
      n.path = `${parent.path}${n.id}/`;
      read.nodes.push(n);
    }
    const focus = read.nodes.at(-1)!;
    read.codeLinks.push({ nodeId: focus.id, repoPath: 'src/changed.ts' });
    const prompt = step.llm!.buildPrompt({ detected: detected(read) } as never) as string;
    expect(prompt).toContain(focus.body);
    expect(prompt).toContain(`version ${focus.version}`);
  },
);

it('holds the external watermark when the whole affected focus cannot fit', async () => {
  const read = fixture(2);
  read.nodes[1]!.body = 'x'.repeat(96_000);
  read.codeLinks.push({ nodeId: read.nodes[1]!.id, repoPath: 'src/changed.ts' });
  vi.mocked(stampExternalWatermark).mockClear();
  const warn = vi.fn();
  const result = await externalPlanSyncStep.apply(
    { logger: { warn } } as never,
    {
      detected: detected(read),
      llmOutput: null,
      formValues: {},
    } as never,
  );
  expect(result.reviewedThrough).toBeNull();
  expect(result.summary).toMatch(/not reviewed|held|too large/i);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      repositoryId: 'repo',
      since: detected(read).since,
      reason: expect.any(String),
    }),
    expect.any(String),
  );
  expect(stampExternalWatermark).not.toHaveBeenCalled();
});

it.each([planReconcileStep, externalPlanSyncStep])(
  'writes and removes the step snapshot around dispatch ($metadata.id)',
  async (step) => {
    const read = fixture();
    const hook = step.llm as { planSnapshot?: (args: unknown) => unknown };
    const planRead = hook.planSnapshot?.({ detected: detected(read) });
    expect(planRead).toBeDefined();
    const root = await mkdtemp(join(tmpdir(), 'plan-writer-snapshot-'));
    const snapshot = {
      ...(planRead as object),
      schemaVersion: 1,
      userId: 'user',
      repositoryId: 'repo',
      taskId: 'task',
      invocationId: 'run',
    };
    try {
      const run = vi.fn(async (opts: DockerRunOpts) => {
        const mount = opts.mounts!.find((m) => m.target === PLAN_CHAT_SNAPSHOT_PATH)!;
        expect(mount.readOnly).toBe(true);
        const saved = JSON.parse(await readFile(join(root, mount.subpath!), 'utf8'));
        expect(saved.nodes).toHaveLength(read.nodes.length);
        expect(saved.invocationId).toBe('run');
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };
      });
      await runInSandbox({ command: 'cli', args: [], planSnapshot: snapshot } as never, {
        image: 'test',
        docker: { run } as unknown as DockerRunner,
        wrapperWorkerPath: root,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(await readdir(join(root, 'plan-chat-snapshots'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('repacking accounts for fixed evidence and refuses a focus rather than cutting it', () => {
  const read = fixture(2);
  read.codeLinks.push({ nodeId: read.nodes[1]!.id, repoPath: 'src/changed.ts' });
  const d = detected(read);
  const assemble = (context: string) => 'standing instructions'.repeat(10) + context;
  const prompt = boundedPlanWriterPrompt(d, assemble, 5_000);
  expect(prompt.length).toBeLessThanOrEqual(5_000);
  expect(prompt).toContain(read.nodes[1]!.body);
  expect(() => boundedPlanWriterPrompt(d, assemble, 1_000)).toThrow(PlanFocusTooLargeError);
});

it('refuses an oversized clarification outline whole at an injectable bound', async () => {
  const db = {
    transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Object.assign(Promise.resolve([]), { orderBy: async () => [] }),
          }),
        }),
      }),
  };
  await expect(renderBoundedPlanOutline(db as never, 'repo', 10)).rejects.toThrow('too large');
});

it.each([planReconcileStep, externalPlanSyncStep])(
  'proposes an index-omitted node by reading the mounted snapshot ($metadata.id)',
  async (step) => {
    const read = fixture(1);
    for (let i = 1; i <= 5; i++) {
      const parent = read.nodes.at(-1)!;
      const n = node(i, parent.id);
      n.path = `${parent.path}${n.id}/`;
      read.nodes.push(n);
    }
    const target = read.nodes.at(-1)!;
    // No code link: this node is outside BOTH focus and the depth-four index.
    const d = detected(read);
    const prompt = step.llm!.buildPrompt({ detected: d } as never) as string;
    expect(prompt).not.toContain(target.id);
    expect(prompt).toContain(PLAN_CHAT_SNAPSHOT_PATH);
    const root = await mkdtemp(join(tmpdir(), 'plan-writer-proposal-'));
    let reply: unknown;
    try {
      const snapshot = {
        ...step.llm!.planSnapshot!({ detected: d } as never),
        schemaVersion: 1,
        userId: 'user',
        repositoryId: 'repo',
        taskId: 'task',
        invocationId: 'run',
      };
      // Mock the CLI, but actually read the private file it receives.
      const run = vi.fn(async (opts: DockerRunOpts) => {
        const mount = opts.mounts!.find((m) => m.target === PLAN_CHAT_SNAPSHOT_PATH)!;
        const saved = JSON.parse(await readFile(join(root, mount.subpath!), 'utf8'));
        const n = saved.nodes.find((n: PlanNodeRecord) => n.id === target.id);
        reply = {
          ops: [
            { op: 'upsert', nodeRef: `node:${n.id}`, expectedVersion: n.version, status: 'done' },
          ],
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(reply),
          stderr: '',
          durationMs: 0,
          timedOut: false,
        };
      });
      await runInSandbox({ command: 'cli', args: [], planSnapshot: snapshot } as never, {
        image: 'test',
        docker: { run } as unknown as DockerRunner,
        wrapperWorkerPath: root,
      });
      vi.mocked(applyPlanPatch).mockResolvedValueOnce({
        created: [],
        updated: [target.id],
        deleted: [],
        linked: 0,
        unlinked: 0,
        codeLinked: 0,
        refs: {},
        dropped: [],
        strippedCodeLinks: [],
      });
      const form = step.form!({} as never, d, reply);
      const field = form?.fields[0];
      expect(field?.type === 'multi-select' && field.options).toHaveLength(1);
      const result = await step.apply(
        { taskId: 'task', logger: { warn: vi.fn() } } as never,
        {
          detected: d,
          llmOutput: reply,
          formValues: { applyOps: ['0'] },
        } as never,
      );
      expect(result.applied).toBe(1);
      expect(vi.mocked(applyPlanPatch).mock.lastCall?.[2]).toMatchObject({
        requireExpectedVersion: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([planReconcileStep, externalPlanSyncStep])(
  'drops invalid read-version ops individually and preserves code-link-only upserts ($metadata.id)',
  async (step) => {
    const read = fixture();
    const target = read.nodes[1]!;
    const context = { taskId: 'task', logger: { warn: vi.fn() } };
    const valid = {
      op: 'upsert',
      nodeRef: read.nodes[2]!.id,
      status: 'done',
      expectedVersion: read.nodes[2]!.version,
    };
    for (const bad of [
      { op: 'upsert', nodeRef: target.id, ordinal: 2 },
      { op: 'upsert', nodeRef: target.id, status: 'done' },
      { op: 'delete', nodeRef: target.id },
      { op: 'upsert', nodeRef: target.id, status: 'done', expectedVersion: target.version + 1 },
      { op: 'upsert', nodeRef: node(99).id, expectedVersion: 1, codeLinks: [] },
    ]) {
      vi.mocked(applyPlanPatch).mockReset();
      vi.mocked(applyPlanPatch).mockResolvedValueOnce({
        created: [],
        updated: [read.nodes[2]!.id],
        deleted: [],
        linked: 0,
        unlinked: 0,
        codeLinked: 0,
        refs: {},
        dropped: [],
        strippedCodeLinks: [],
      });
      const result = await step.apply(
        context as never,
        {
          detected: detected(read),
          llmOutput: { ops: [bad, valid] },
          formValues: { applyOps: ['0', '1'] },
        } as never,
      );
      expect(result.decision).toBe('applied');
      expect(result.applied).toBe(1);
      expect(result.dropped).toHaveLength(1);
      expect(result.summary).toContain('1 approved change(s) could not be applied');
      expect(vi.mocked(applyPlanPatch).mock.lastCall?.[1]).toMatchObject({ ops: [valid] });
    }
    // The shared applier allowed this shape before bounded workflow prompts.
    vi.mocked(applyPlanPatch).mockReset();
    vi.mocked(applyPlanPatch).mockResolvedValueOnce({
      created: [],
      updated: [target.id],
      deleted: [],
      linked: 0,
      unlinked: 0,
      codeLinked: 1,
      refs: {},
      dropped: [],
      strippedCodeLinks: [],
    });
    const linksOnly = {
      op: 'upsert',
      nodeRef: target.id,
      codeLinks: [{ repoPath: 'src/changed.ts', evidence: 'Implements this component' }],
    };
    const result = await step.apply(
      context as never,
      {
        detected: detected(read),
        llmOutput: { ops: [linksOnly] },
        formValues: { applyOps: ['0'] },
      } as never,
    );
    expect(result.applied).toBe(1);
    expect(result.codeLinked).toBe(1);
    expect(vi.mocked(applyPlanPatch).mock.lastCall?.[1]).toMatchObject({ ops: [linksOnly] });
    expect(vi.mocked(applyPlanPatch).mock.lastCall?.[2].requireAllUpdateVersions).not.toBe(true);
  },
);

it.each([planReconcileStep, externalPlanSyncStep])(
  'reports a real stale CAS once without retrying against a newer read ($metadata.id)',
  async (step) => {
    const read = fixture();
    const target = read.nodes[1]!;
    vi.mocked(applyPlanPatch).mockReset();
    vi.mocked(stampExternalWatermark).mockClear();
    vi.mocked(applyPlanPatch).mockRejectedValueOnce(
      new PlanPatchError('conflict', 'concurrent canvas edit'),
    );
    const result = await step.apply(
      { taskId: 'task', logger: { warn: vi.fn() } } as never,
      {
        detected: detected(read),
        llmOutput: {
          ops: [
            { op: 'upsert', nodeRef: target.id, status: 'done', expectedVersion: target.version },
          ],
        },
        formValues: { applyOps: ['0'] },
      } as never,
    );
    expect(result.decision).toBe('conflict');
    expect(applyPlanPatch).toHaveBeenCalledOnce();
    expect(stampExternalWatermark).not.toHaveBeenCalled();
  },
);

it.each(['commitsOmitted', 'pathsOmitted'] as const)(
  'reviews a capped %s range and stamps after disclosing the omission',
  async (field) => {
    vi.mocked(stampExternalWatermark).mockClear();
    const d = { ...detected(), [field]: 1 };
    const args = { detected: d, llmOutput: { ops: [] }, formValues: {} };
    expect(externalPlanSyncStep.llm!.skipIf!(args as never)).toBe(false);
    expect(await externalPlanSyncStep.llm!.prepare!({ ...args, ctx: {} } as never)).not.toBe(false);
    const prompt = externalPlanSyncStep.llm!.buildPrompt(args as never) as string;
    expect(prompt).toMatch(field === 'commitsOmitted' ? /1 further commit/ : /1 further path/);
    const proposal = {
      ops: [{ op: 'upsert', parentRef: d.planRead.nodes[0]!.id, title: 'New capability' }],
    };
    expect(externalPlanSyncStep.form!({} as never, d, proposal)?.description).toContain(
      field === 'commitsOmitted' ? '(+1 not listed)' : 'touching 1 file(s)',
    );
    const result = await externalPlanSyncStep.apply({} as never, args as never);
    expect(result.decision).toBe('nothing_to_review');
    expect(result.commitsReviewed).toBe(1);
    expect(result.reviewedThrough).toBe(d.branchPoint);
    expect(stampExternalWatermark).toHaveBeenCalledWith(undefined, 'repo', 'plan', d.branchPoint);
  },
);

it.each([planReconcileStep, externalPlanSyncStep])(
  'applies unversioned code links through the real applier while reporting a dropped field op ($metadata.id)',
  async (step) => {
    const read = fixture(2);
    const fake = createFakeDb({
      repositories: schema.repositories,
      planNodes: schema.planNodes,
      planNodeEdges: schema.planNodeEdges,
      planNodeCodeLinks: schema.planNodeCodeLinks,
      planMirrorState: schema.planMirrorState,
    });
    const repositoryId = node(90).id;
    fake.insert(schema.repositories, { id: repositoryId, userId: node(91).id, name: 'repo' });
    for (const n of read.nodes) fake.insert(schema.planNodes, { ...n, repositoryId });
    fake.insert(schema.planMirrorState, { repositoryId, revision: 1 });
    const actual = await vi.importActual<typeof import('@haive/shared/plan')>('@haive/shared/plan');
    vi.mocked(applyPlanPatch).mockReset();
    vi.mocked(applyPlanPatch).mockImplementation(actual.applyPlanPatch);
    try {
      const context = {
        db: fake.db as unknown as Database,
        taskId: node(92).id,
        logger: { warn: vi.fn() },
      };
      const linksOnly = {
        op: 'upsert',
        nodeRef: read.nodes[1]!.id,
        codeLinks: [{ repoPath: 'src/changed.ts', evidence: 'Implements this component' }],
      };
      const bad = { op: 'upsert', nodeRef: read.nodes[0]!.id, status: 'done' };
      const result = await step.apply(
        context as never,
        {
          detected: { ...detected(read), repositoryId },
          llmOutput: { ops: [bad, linksOnly] },
          formValues: { applyOps: ['0', '1'] },
        } as never,
      );
      expect(result.applied).toBe(1);
      expect(result.dropped).toHaveLength(1);
      expect(result.codeLinked).toBe(1);
      expect(await context.db.select().from(schema.planNodeCodeLinks)).toMatchObject([
        { nodeId: read.nodes[1]!.id, repoPath: 'src/changed.ts' },
      ]);
      // An entirely invalid set is reported as dropped, including an empty applier patch.
      const empty = await step.apply(
        context as never,
        {
          detected: { ...detected(read), repositoryId },
          llmOutput: { ops: [bad] },
          formValues: { applyOps: ['0'] },
        } as never,
      );
      expect(empty.decision).toBe('applied');
      expect(empty.applied).toBe(0);
      expect(empty.dropped).toHaveLength(1);
    } finally {
      vi.mocked(applyPlanPatch).mockReset();
    }
  },
);

it.each([planReconcileStep, externalPlanSyncStep])(
  'names missing agent output without blaming focus size ($metadata.id)',
  async (step) => {
    const warn = vi.fn();
    vi.mocked(stampExternalWatermark).mockClear();
    const d = detected();
    const result = await step.apply(
      { logger: { warn } } as never,
      {
        detected: d,
        llmOutput: null,
        formValues: {},
      } as never,
    );
    expect(result.decision).toBe(step === externalPlanSyncStep ? 'not_measured' : 'nothing_to_do');
    expect(result.summary).toContain('no agent output');
    expect(result.summary).not.toMatch(/whole plan focus|too large|already described/);
    expect(stampExternalWatermark).not.toHaveBeenCalled();
    if (step === externalPlanSyncStep) {
      expect(result.summary).toContain('watermark is held');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: d.repositoryId,
          since: d.since,
          reason: 'no_agent_output',
        }),
        expect.any(String),
      );
    }
  },
);

it.each([planReconcileStep, externalPlanSyncStep])(
  'names the largest linked focus node when the review is skipped for size ($metadata.id)',
  async (step) => {
    const read = fixture(3);
    read.nodes[1]!.body = 'small';
    read.nodes[2]!.body = 'largest'.repeat(50);
    read.codeLinks = read.nodes.slice(1).map((n) => ({ nodeId: n.id, repoPath: 'src/changed.ts' }));
    const d = { ...detected(read), focusTooLarge: true };
    const warn = vi.fn();
    vi.mocked(stampExternalWatermark).mockClear();
    const result = await step.apply(
      { logger: { warn } } as never,
      {
        detected: d,
        llmOutput: null,
        formValues: {},
      } as never,
    );
    expect(result.summary).toMatch(/exceed.*budget/);
    expect(result.summary).toContain('Largest focus node: node:' + read.nodes[2]!.id);
    expect(result.decision).toBe(step === externalPlanSyncStep ? 'not_measured' : 'nothing_to_do');
    expect(stampExternalWatermark).not.toHaveBeenCalled();
    if (step === externalPlanSyncStep)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: d.repositoryId,
          since: d.since,
          reason: 'focus_too_large',
        }),
        expect.any(String),
      );
  },
);
