import { advanceStep } from './step-runner.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  resolveDagPhase,
  resolveEscalationPhase,
  resolveReviewPhase,
  replannerPrompt,
  parseCoderResult,
  ingestReviewRun,
  ingestAdvisor,
} from './dag-executor.js';
import {
  OUTPUT_TRUNCATION_HEADLINE,
  PROVIDER_FATAL_HEADLINES,
} from '../queues/cli-exec/failure-class.js';
import { StepSupersededError } from './step-ownership.js';
import { resolveTaskDispatch } from '../orchestrator/dispatcher.js';
import { gitRun } from '../repo/git-exec.js';
import { recordLedgerEntry } from './task-ledger.js';
import {
  openMerge,
  abortOtherMerge,
  abortMerge,
  mergeOpenFor,
  relocateFixerChanges,
  completeMergeHostSide,
} from './git-merge.js';
import {
  issueNoChange,
  issueBlocked,
  DAG_NO_CHANGE_MARKER,
  DAG_FINAL_FAILURE_MARKER,
  DAG_BLOCKED_BY_MARKER,
  loadDagOutcomeCounts,
} from './dag-outcomes.js';

vi.mock('./steps/workflow/_fix-test-store.js', () => ({
  beginFixTestCapture: vi.fn(),
  finishFixTestCapture: vi.fn(),
}));

vi.mock('../orchestrator/dispatcher.js', () => ({ resolveTaskDispatch: vi.fn() }));
vi.mock('../repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../repo/git-exec.js')>()),
  gitRun: vi.fn(),
}));
vi.mock('./git-merge.js', async (original) => ({
  ...(await original<typeof import('./git-merge.js')>()),
  openMerge: vi.fn(),
  abortOtherMerge: vi.fn(),
  abortMerge: vi.fn(),
  mergeOpenFor: vi.fn(),
  relocateFixerChanges: vi.fn(),
  completeMergeHostSide: vi.fn(),
}));
vi.mock('./left-open-merge.js', async (original) => ({
  ...(await original<typeof import('./left-open-merge.js')>()),
  peekOpenMerge: async () => null,
}));
vi.mock('../project-state/branch-revert.js', async (original) => ({
  ...(await original<typeof import('../project-state/branch-revert.js')>()),
  putBackProjections: async () => [],
}));
vi.mock('../secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('./steps/workflow/_dependency-policy.js', () => ({
  assertDependencyCommitSafe: async () => {},
}));
vi.mock('./steps/workflow/_gitlink-registration.js', async (original) => ({
  ...(await original<typeof import('./steps/workflow/_gitlink-registration.js')>()),
  unregisteredGitlinks: async () => [],
}));
vi.mock('./steps/workflow/_spec-artifact.js', async (original) => ({
  ...(await original<typeof import('./steps/workflow/_spec-artifact.js')>()),
  resolveSpecView: async () => ({ text: '', condensed: false }),
}));
vi.mock('./task-ledger.js', () => ({
  augmentPromptWithLedger: async (_db: unknown, _task: unknown, p: string) => p,
  recordLedgerEntry: vi.fn(),
}));
vi.mock('./terseness-context.js', () => ({ augmentPromptWithTerseness: async (p: string) => p }));
vi.mock('./attachments-context.js', () => ({ augmentPromptWithAttachments: async () => '' }));
vi.mock('../attachments/expand-archives.js', () => ({ ensureArchivesExpanded: async () => {} }));
vi.mock('./steps/workflow/_task-meta.js', () => ({
  loadTaskMeta: async () => ({ title: 'Task', description: '' }),
}));
vi.mock('./steps/workflow/_plan-impact.js', () => ({
  loadPlanImpactContext: async () => null,
  planImpactBlock: () => '',
}));
vi.mock('../sandbox/sandbox-kill.js', () => ({ killCliSandboxesForTask: async () => {} }));

const integrationFixture = vi.hoisted(() => ({ path: '/repo/integration' }));
vi.mock('./steps/onboarding/_helpers.js', async (original) => ({
  ...(await original<typeof import('./steps/onboarding/_helpers.js')>()),
  loadPreviousStepOutput: async () => ({
    output: {
      worktreePath: integrationFixture.path,
      branchName: 'feature',
      sandboxWorktreePath: integrationFixture.path,
    },
  }),
}));

vi.mock('../sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../sandbox/ddev-runner.js')>()),
  closeRunnerExtraTabs: async () => 0,
  restoreRunnerBrowserWindow: async () => 0,
}));

const success = { code: 0, stdout: '', stderr: '' };
const dispatch = () =>
  ({ mode: 'cli', providerId: 'provider', invocation: { kind: 'cli', spec: {} } }) as never;
function issue(key: string, patch = {}) {
  return {
    id: key,
    issueKey: key,
    dagPlanId: 'plan',
    taskId: 'task',
    level: 0,
    title: key,
    outcome: 'completed',
    resolution: null,
    mergeStatus: null,
    mergedAt: null,
    branchName: `feature--${key}`,
    worktreePath: `/repo/${key}`,
    sandboxWorktreePath: `/repo/${key}`,
    cliInvocationId: null,
    concerns: '',
    errorMessage: null,
    dependsOn: [],
    debtItems: [],
    similarSites: [],
    filesModified: [],
    estimatedFiles: [],
    specSections: [],
    acceptanceCriteria: [],
    innerIteration: 0,
    advisorInvocations: 0,
    lastAdvisorAction: null,
    reviewInfraRetries: 0,
    infraRetries: 0,
    ...patch,
  };
}
type Row = Record<string, any>;
// Evaluate equality binds on their column encoders, rather than ignoring query scope.
function matches(cond: any, row: Row): boolean {
  if (!cond?.queryChunks) return true;
  const chunks = cond.queryChunks;
  const col = chunks.find((x: any) => x?.table && typeof x.name === 'string');
  const param = chunks.find((x: any) => x && 'encoder' in x && 'value' in x);
  if (col && param) {
    const key = Object.keys(col.table).find((k) => col.table[k] === col)!;
    return row[key] === param.value;
  }
  return chunks.every((x: any) => !x?.queryChunks || matches(x, row));
}
function fixture(rows: Row[], review = false) {
  const plan: Row = {
    id: 'plan',
    taskId: 'task',
    mode: 'dag',
    reviewEnabled: review,
    levels: [...new Set(rows.map((i) => i.level))].map((l) =>
      rows.filter((i) => i.level === l).map((i) => i.issueKey),
    ),
    autoResolveConflicts: false,
    replannerInvocationId: null,
    replannerInvocations: 0,
  };
  const levels = plan.levels.map((_: unknown, level: number) => ({
    id: `level-${level}`,
    dagPlanId: 'plan',
    level,
    checkpointedAt: null,
    mergeState: null,
  }));
  const step: Row = { id: 'step', status: 'running', round: 0 };
  const invocations: Row[] = [];
  const runs: Row[] = [];
  const events: Row[] = [];
  const tables = new Map<unknown, Row[]>([
    [schema.taskDagIssues, rows],
    [schema.taskDagLevels, levels],
    [schema.taskDagPlans, [plan]],
    [schema.cliInvocations, invocations],
    [schema.dagAgentRuns, runs],
    [schema.taskEvents, events],
    [schema.taskSteps, [step]],
  ]);
  let fault: ((table: unknown, patch: Row) => void) | undefined;
  const checkpoints: string[] = [];
  const operations: { kind: 'lock' | 'write'; table: unknown }[] = [];
  const db: any = {
    transaction: async (fn: any) => {
      const snapshot = [...tables].map(([t, rs]) => [t, structuredClone(rs)] as const);
      try {
        return await fn(db);
      } catch (e) {
        for (const [t, rs] of snapshot) {
          const target = tables.get(t)!;
          target.forEach((r, i) => {
            if (rs[i]) {
              for (const k of Object.keys(r)) delete r[k];
              Object.assign(r, rs[i]);
            }
          });
          target.splice(rs.length);
        }
        throw e;
      }
    },
    query: new Proxy(
      {},
      {
        get: (_, name) => ({
          findFirst: async (opts: any) => {
            if (name === 'taskDagPlans') return plan;
            if (name === 'cliInvocations') return invocations.find((i) => matches(opts.where, i));
            if (name === 'taskSteps') return step;
            return undefined;
          },
        }),
      },
    ),
    select: (cols: Row | undefined) => ({
      from: (table: unknown) => {
        let cond: unknown;
        let take = Infinity;
        const c: any = {
          where: (x: unknown) => {
            cond = x;
            return c;
          },
          orderBy: () => c,
          limit: (n: number) => {
            take = n;
            return c;
          },
          for: async () => {
            operations.push({ kind: 'lock', table });
            return table === schema.taskSteps
              ? ['pending', 'failed', 'skipped'].includes(step.status)
                ? []
                : [{ id: 'step' }]
              : (tables.get(table) ?? []).filter((r) => matches(cond, r)).map((r) => ({ ...r }));
          },
          then: (ok: any, no: any) =>
            Promise.resolve(
              (tables.get(table) ?? [])
                .filter((r) => matches(cond, r))
                .slice(0, take)
                .map((r) => {
                  if (table === schema.taskSteps && !cols?.id)
                    return {
                      ...r,
                      output: {
                        worktreePath: integrationFixture.path,
                        branchName: 'feature',
                        sandboxWorktreePath: integrationFixture.path,
                      },
                    };
                  return { ...r };
                }),
            ).then(ok, no),
        };
        return c;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (cond: unknown) => {
          const apply = () => {
            fault?.(table, patch);
            operations.push({ kind: 'write', table });
            if (
              table === schema.taskSteps &&
              ['pending', 'failed', 'skipped'].includes(step.status)
            )
              return [];
            const selected = (tables.get(table) ?? []).filter((r) => matches(cond, r));
            for (const r of selected) {
              Object.assign(r, patch);
              if (patch.checkpointedAt) checkpoints.push(r.id);
            }
            return selected;
          };
          return {
            returning: async () => apply(),
            then: (ok: any, no: any) => Promise.resolve().then(apply).then(ok, no),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        const apply = () => {
          const r = { id: `inv-${invocations.length}`, ...v };
          tables.get(table)!.push(r);
          return [r];
        };
        return {
          returning: async () => apply(),
          then: (ok: any, no: any) => Promise.resolve().then(apply).then(ok, no),
        };
      },
    }),
  };
  const stepDef = {
    metadata: { id: 'custom.execute' },
    dagExecute: {
      requiredCapabilities: ['tool_use'],
      failurePolicy: 'record-and-continue',
      buildCoderPrompt: (i: Row) => i.issueKey,
    },
  };
  const enqueued: Row[] = [];
  const params = {
    taskId: 'task',
    userId: 'user',
    workspacePath: '/repo',
    providers: [],
    deps: {
      enqueueCliInvocation: async (p: Row) => {
        enqueued.push(p);
      },
    },
  };
  const ctx = {
    db,
    taskId: 'task',
    userId: 'user',
    repoPath: '/repo',
    sandboxWorkdir: '/repo',
    logger,
    emitProgress: async () => {},
  };
  return {
    db,
    plan,
    levels,
    rows,
    step,
    invocations,
    runs,
    events,
    checkpoints,
    operations,
    stepDef,
    enqueued,
    params,
    ctx,
    fault: (f?: typeof fault) => {
      fault = f;
    },
    run: () => resolveDagPhase(db, stepDef as never, step as never, ctx as never, params as never),
    escalate: (snapshot = rows) =>
      resolveEscalationPhase({
        db,
        plan,
        issues: snapshot,
        level: levels[0],
        current: step,
        params,
        stepDef,
        providers: [],
        deps: params.deps,
        taskId: 'task',
        specView: { text: '', condensed: false },
        attachmentsNotice: '',
      } as never),
  };
}
beforeEach(() => {
  integrationFixture.path = '/repo/integration';
  vi.mocked(resolveTaskDispatch).mockReset().mockResolvedValue(dispatch());
  vi.mocked(gitRun)
    .mockReset()
    .mockImplementation(async (_cwd, args) => ({
      ...success,
      code: args.includes('diff-tree') ? 1 : 0,
      stdout: args.includes('show') ? `${String(args.at(-1)).split('--').at(-1)}: done` : '',
    }));
  vi.mocked(openMerge)
    .mockReset()
    .mockResolvedValue({ kind: 'merged' } as never);
  vi.mocked(abortOtherMerge).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(abortMerge).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(mergeOpenFor).mockReset().mockResolvedValue(true);
  vi.mocked(relocateFixerChanges).mockReset().mockResolvedValue(null);
  vi.mocked(completeMergeHostSide).mockReset().mockResolvedValue(false);
});

const failure = { outcome: 'failed_unrecoverable', resolution: 'failed_unrecoverable' };
describe('issue-result aborts', () => {
  for (const review of [false, true])
    for (const policy of ['fail-step', 'record-and-continue'] as const) {
      for (const kind of ['coder', 'refusal', 'replanner-abort', 'replan-exhausted'] as const) {
        if (!review && !['coder', 'refusal'].includes(kind)) continue;
        it(`${kind}, review=${review}, policy=${policy}`, async () => {
          const h = fixture(
            [
              issue('A', {
                ...failure,
                ...(kind === 'refusal'
                  ? { errorMessage: `${PROVIDER_FATAL_HEADLINES.content_filter}: denied` }
                  : {}),
                advisorInvocations: 3,
                lastAdvisorAction: 'ESCALATE_TO_REPLAN',
              }),
              issue('D', { resolution: review ? 'approved' : null }),
            ],
            review,
          );
          h.stepDef.dagExecute.failurePolicy = policy;
          if (kind === 'replanner-abort') {
            h.plan.replannerInvocationId = 'replan';
            h.invocations.push({
              id: 'replan',
              endedAt: new Date(),
              startedAt: new Date(),
              exitCode: 0,
              parsedOutput: {
                action: 'ABORT',
                reasoning: 'declined',
                skip_downstream: [],
                new_levels: [],
              },
            });
          } else h.plan.replannerInvocations = 3;
          const r = await h.run();
          expect(r.resolved).toBe(policy === 'record-and-continue');
          expect(openMerge).toHaveBeenCalledTimes(policy === 'record-and-continue' ? 1 : 0);
          if (policy === 'record-and-continue') {
            expect(h.rows[0]?.resolution).toBe('failed_unrecoverable');
            expect(h.rows[1]?.mergeStatus).toBe('clean');
            expect(h.checkpoints).toEqual(['level-0']);
          }
        });
      }
    }
});

it('blocks A -> B -> C before any worktree or dispatch while independent D merges', async () => {
  const h = fixture([
    issue('A', failure),
    issue('B', {
      level: 1,
      outcome: 'pending',
      worktreePath: null,
      branchName: null,
      dependsOn: ['A'],
    }),
    issue('C', {
      level: 2,
      outcome: 'pending',
      worktreePath: null,
      branchName: null,
      dependsOn: ['B'],
    }),
    issue('D'),
  ]);
  expect((await h.run()).resolved).toBe(true);
  expect(h.rows.filter((i) => issueBlocked(i as never)).map((i) => i.issueKey)).toEqual(['B', 'C']);
  expect(h.enqueued).toEqual([]);
  expect(gitRun).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining(['worktree', 'add']),
    expect.anything(),
  );
  expect(vi.mocked(openMerge).mock.calls.map((c) => c[1])).toEqual(['feature--D']);
});

it('keeps an empty branch unmerged, blocks its dependent and checkpoints once on re-entry', async () => {
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => ({
    ...success,
    stdout: args.includes('show') ? 'A: done' : '',
  }));
  const h = fixture([
    issue('A'),
    issue('B', {
      level: 1,
      outcome: 'pending',
      worktreePath: null,
      branchName: null,
      dependsOn: ['A'],
    }),
  ]);
  expect((await h.run()).resolved).toBe(true);
  expect(issueNoChange(h.rows[0] as never)).toBe(true);
  expect(h.rows[0]).toMatchObject({ mergeStatus: null, mergedAt: null });
  expect(openMerge).not.toHaveBeenCalled();
  expect((await h.run()).resolved).toBe(true);
  expect(h.checkpoints).toEqual(['level-0', 'level-1']);
  expect(await loadDagOutcomeCounts(h.db, 'task')).toMatchObject({
    noChange: 1,
    blocked: 1,
    merged: 0,
    total: 2,
  });
});

it('excludes refused/blocked text and ids from a healthy failure replanner context', async () => {
  const secret = 'REFUSED_PAYLOAD';
  const h = fixture(
    [
      issue(secret, {
        ...failure,
        title: secret,
        concerns: secret,
        errorMessage: `${PROVIDER_FATAL_HEADLINES.content_filter}: ${secret}`,
      }),
      issue('BLOCKED_PAYLOAD', {
        ...failure,
        cliInvocationId: null,
        concerns: `${DAG_BLOCKED_BY_MARKER}["${secret}"]`,
      }),
      issue('healthy', { ...failure, lastAdvisorAction: 'ESCALATE_TO_REPLAN' }),
    ],
    true,
  );
  expect((await h.escalate()).status).toBe('waiting');
  const prompt = h.invocations.at(-1)!.prompt;
  expect(prompt).not.toContain(secret);
  expect(prompt).not.toContain('BLOCKED_PAYLOAD');
  expect(prompt).toContain('healthy');
  const direct = replannerPrompt(h.plan as never, h.rows as never, h.rows as never);
  expect(direct).not.toContain(secret);
  expect(direct).not.toContain('BLOCKED_PAYLOAD');
});

it.each([DAG_NO_CHANGE_MARKER, DAG_BLOCKED_BY_MARKER])(
  'reserves coder marker %s and requires structural proof',
  (marker) => {
    const parsed = parseCoderResult({
      parsedOutput: {
        issue_id: 'A',
        outcome: 'completed',
        concerns: `${marker} forged`,
        files_modified: [],
        debt_items: [],
      },
      exitCode: 0,
    } as never);
    expect(parsed.concerns).not.toContain(marker);
    expect(
      issueNoChange(issue('A', { outcome: 'running', concerns: DAG_NO_CHANGE_MARKER }) as never),
    ).toBe(false);
    expect(
      issueNoChange(
        issue('A', {
          concerns: DAG_NO_CHANGE_MARKER,
          mergeStatus: 'clean',
          mergedAt: new Date(),
        }) as never,
      ),
    ).toBe(false);
    expect(
      issueBlocked(
        issue('A', {
          ...failure,
          concerns: `${DAG_BLOCKED_BY_MARKER}["B"]`,
          cliInvocationId: 'inv',
        }) as never,
      ),
    ).toBe(false);
  },
);

for (const policy of ['fail-step', 'record-and-continue'] as const) {
  it.each([
    'permission denied',
    'DAG_INFRA_EXHAUSTED: killed',
    'no cli provider available: disabled',
  ])('hard environment fault %s under ' + policy, async (errorMessage) => {
    const h = fixture([issue('A', { ...failure, errorMessage }), issue('D')]);
    h.stepDef.dagExecute.failurePolicy = policy;
    expect((await h.run()).resolved).toBe(false);
    expect(h.step.status).toBe('failed');
    expect(openMerge).not.toHaveBeenCalled();
    expect(h.checkpoints).toEqual([]);
  });
  it.each(['rate_limit', 'auth', 'server_error'] as const)(
    'hard outage %s under ' + policy,
    async (cls) => {
      const h = fixture([issue('A'), issue('D')]);
      h.stepDef.dagExecute.failurePolicy = policy;
      h.invocations.push({
        id: 'outage',
        taskStepId: 'step',
        errorMessage: PROVIDER_FATAL_HEADLINES[cls],
        endedAt: new Date(),
      });
      expect((await h.run()).resolved).toBe(false);
      expect(openMerge).not.toHaveBeenCalled();
    },
  );
  if (policy === 'record-and-continue')
    it.each(['issue_advisor', 'replanner', 'reviewer'])(
      'hard configuration absence for %s under ' + policy,
      async (role) => {
        const h = fixture(
          [
            issue(
              'A',
              role === 'reviewer'
                ? {}
                : {
                    ...failure,
                    ...(role === 'replanner' ? { lastAdvisorAction: 'ESCALATE_TO_REPLAN' } : {}),
                  },
            ),
          ],
          true,
        );
        h.stepDef.dagExecute.failurePolicy = policy;
        vi.mocked(resolveTaskDispatch).mockResolvedValue({
          mode: 'skip',
          reason: 'disabled',
        } as never);
        await expect(h.run()).rejects.toThrow(/no cli provider available/i);
        expect(h.checkpoints).toEqual([]);
      },
    );
  it('hard merge refusal under ' + policy, async () => {
    const h = fixture([issue('D')]);
    h.stepDef.dagExecute.failurePolicy = policy;
    vi.mocked(openMerge).mockResolvedValue({ kind: 'refused', detail: 'dirty checkout' } as never);
    expect((await h.run()).resolved).toBe(false);
    expect(h.checkpoints).toEqual([]);
  });
}

it.each(['before outcome', 'after merge', 'before checkpoint'])(
  'resumes a crash %s without coder redispatch or duplicate landed merge',
  async (point) => {
    const h = fixture([issue('A', failure), issue('D')]);
    let once = true;
    h.fault((table, patch) => {
      if (!once) return;
      if (
        (point === 'before outcome' &&
          table === schema.taskDagIssues &&
          patch.resolution === 'failed_unrecoverable') ||
        (point === 'after merge' &&
          table === schema.taskDagIssues &&
          patch.mergeStatus === 'clean') ||
        (point === 'before checkpoint' && table === schema.taskDagLevels && patch.checkpointedAt)
      ) {
        once = false;
        throw new Error('crash');
      }
    });
    const landed = new Set<string>();
    let commits = 0;
    vi.mocked(openMerge).mockImplementation(async (_dir, ref) => {
      if (!landed.has(ref)) {
        landed.add(ref);
        commits++;
      }
      return { kind: 'merged' } as never;
    });
    await expect(h.run()).rejects.toThrow('crash');
    h.fault();
    expect((await h.run()).resolved).toBe(true);
    expect(h.enqueued).toEqual([]);
    expect(commits).toBe(1);
    expect(h.checkpoints).toEqual(['level-0']);
  },
);

it('ownership loss cannot be recorded as a partial success', async () => {
  const h = fixture([issue('A', failure)]);
  h.step.status = 'pending';
  await expect(h.run()).rejects.toBeInstanceOf(StepSupersededError);
  expect(h.checkpoints).toEqual([]);
});

it('does not block a dependent while its prerequisite can still be advised', async () => {
  const h = fixture(
    [
      issue('A', failure),
      issue('B', {
        level: 1,
        outcome: 'pending',
        worktreePath: null,
        branchName: null,
        dependsOn: ['A'],
      }),
    ],
    true,
  );
  expect((await h.run()).resolved).toBe(false);
  expect(h.rows[1]?.outcome).toBe('pending');
  expect(h.enqueued).toHaveLength(1);
});

it.each([false, true])(
  'replays a durable no-change result before checkpoint without committing or merging it (review=%s)',
  async (review) => {
    const normalGit = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (dir, args, opts) =>
      args.includes('show') && args.at(-1) === 'feature--A' ? success : normalGit(dir, args, opts),
    );
    const h = fixture(
      [
        issue('A', { resolution: review ? 'approved' : null }),
        issue('D', { resolution: review ? 'approved' : null }),
      ],
      review,
    );
    h.fault((table, patch) => {
      if (table === schema.taskDagLevels && patch.checkpointedAt)
        throw new Error('before checkpoint');
    });
    await expect(h.run()).rejects.toThrow('before checkpoint');
    expect(issueNoChange(h.rows[0] as never)).toBe(true);
    expect(h.rows[0]?.mergeStatus).toBeNull();
    const calls = vi.mocked(gitRun).mock.calls.length;
    h.fault();
    expect((await h.run()).resolved).toBe(true);
    expect(
      vi
        .mocked(gitRun)
        .mock.calls.slice(calls)
        .filter(([dir, args]) => dir === '/repo/A' && !args.includes('remove')),
    ).toEqual([]);
    expect(vi.mocked(openMerge).mock.calls.map((c) => c[1])).toEqual(['feature--D']);
    expect(h.checkpoints).toEqual(['level-0']);
  },
);

for (const policy of ['fail-step', 'record-and-continue'] as const) {
  if (policy === 'record-and-continue')
    it.each(['advisor', 'replanner'])(
      'keeps %s environment faults hard under ' + policy,
      async (role) => {
        const h = fixture([issue('A', failure)], true);
        h.stepDef.dagExecute.failurePolicy = policy;
        const inv = {
          id: 'agent',
          taskStepId: 'step',
          startedAt: new Date(),
          endedAt: new Date(),
          exitCode: 1,
          errorMessage: 'permission denied',
          parsedOutput: { action: 'ABORT' },
        };
        h.invocations.push(inv);
        if (role === 'replanner') h.plan.replannerInvocationId = inv.id;
        else
          h.runs.push({
            id: 'advice',
            dagIssueId: 'A',
            role: 'issue_advisor',
            consumedAt: null,
            cliInvocationId: inv.id,
          });
        await expect(h.run()).rejects.toThrow(/permission denied/);
        expect(h.checkpoints).toEqual([]);
        expect(h.rows[0]?.concerns).toBe('');
      },
    );
  it('keeps a refused merge fixer hard under ' + policy, async () => {
    const h = fixture([issue('D', { mergeStatus: 'conflict' })]);
    h.stepDef.dagExecute.failurePolicy = policy;
    h.levels[0].mergeState = { activeConflict: 'D', fixInvocationId: 'fixer', conflictRetries: {} };
    h.invocations.push({
      id: 'fixer',
      startedAt: new Date(),
      endedAt: new Date(),
      exitCode: 1,
      errorMessage: PROVIDER_FATAL_HEADLINES.content_filter,
    });
    expect((await h.run()).resolved).toBe(false);
    expect(h.checkpoints).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(abortMerge).toHaveBeenCalled();
  });
  it('keeps a refused merge abort hard under ' + policy, async () => {
    const h = fixture([issue('D')]);
    h.stepDef.dagExecute.failurePolicy = policy;
    vi.mocked(abortOtherMerge).mockResolvedValue({
      ok: false,
      blocking: ['a'],
      detail: 'abort refused',
    });
    expect((await h.run()).resolved).toBe(false);
    expect(h.checkpoints).toEqual([]);
    expect(h.events.some((e) => e.eventType === 'merge.abort_failed')).toBe(true);
  });
  it('does not turn ownership loss into completion under ' + policy, async () => {
    const h = fixture([issue('A', failure)]);
    h.stepDef.dagExecute.failurePolicy = policy;
    h.step.status = 'pending';
    await expect(h.run()).rejects.toBeInstanceOf(StepSupersededError);
    expect(h.checkpoints).toEqual([]);
  });
}

it('atomically retains a replanner ABORT across an interrupted outcome publication', async () => {
  const h = fixture([issue('A', failure), issue('D', { resolution: 'approved' })], true);
  h.plan.replannerInvocationId = 'replan';
  h.invocations.push({
    id: 'replan',
    startedAt: new Date(),
    endedAt: new Date(),
    exitCode: 0,
    parsedOutput: {
      action: 'ABORT',
      reasoning: 'legitimate decline',
      skip_downstream: [],
      new_levels: [],
    },
  });
  h.fault((table, patch) => {
    if (table === schema.taskDagPlans && patch.lastReplannerAction === 'ABORT')
      throw new Error('outcome crash');
  });
  await expect(h.run()).rejects.toThrow('outcome crash');
  expect(h.plan.replannerInvocationId).toBe('replan');
  expect(h.plan.replannerInvocations).toBe(0);
  expect(h.rows[0]?.concerns).toBe('');
  h.fault();
  expect((await h.run()).resolved).toBe(true);
  expect(h.plan.replannerInvocations).toBe(1);
  expect(h.enqueued).toEqual([]);
});

it('the default hook still fails on an empty branch and never checkpoints it', async () => {
  const h = fixture([issue('A')]);
  delete (h.stepDef.dagExecute as { failurePolicy?: string }).failurePolicy;
  vi.mocked(gitRun).mockResolvedValue(success);
  expect((await h.run()).resolved).toBe(false);
  expect(h.step.errorMessage).toContain('no branch changes');
  expect(h.checkpoints).toEqual([]);
  expect(openMerge).not.toHaveBeenCalled();
});

it('real git leaves a no-change branch unmerged while a sibling commit lands once', async () => {
  const realGit =
    await vi.importActual<typeof import('../repo/git-exec.js')>('../repo/git-exec.js');
  const realMerge = await vi.importActual<typeof import('./git-merge.js')>('./git-merge.js');
  vi.mocked(gitRun).mockImplementation(realGit.gitRun);
  vi.mocked(openMerge).mockImplementation(realMerge.openMerge);
  const root = await mkdtemp(path.join(tmpdir(), 'dag-record-git-'));
  try {
    const git = async (...args: string[]) => {
      const r = await realGit.gitRun(root, args);
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git('init', '-b', 'feature');
    await writeFile(path.join(root, '.gitignore'), '/A/\n/D/\n');
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    await git('add', '.');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture: base',
    );
    await git('worktree', 'add', '-b', 'feature--A', path.join(root, 'A'));
    await git('worktree', 'add', '-b', 'feature--D', path.join(root, 'D'));
    await writeFile(path.join(root, 'D', 'delivered.txt'), 'delivered\n');
    integrationFixture.path = root;
    const h = fixture([
      issue('A', { worktreePath: path.join(root, 'A') }),
      issue('D', { worktreePath: path.join(root, 'D') }),
    ]);
    h.ctx.repoPath = root;
    expect((await h.run()).resolved).toBe(true);
    expect(h.rows[0]).toMatchObject({ mergeStatus: null, mergedAt: null });
    expect(issueNoChange(h.rows[0] as never)).toBe(true);
    expect(h.rows[1]?.mergeStatus).toBe('clean');
    expect(await git('show', 'HEAD:delivered.txt')).toBe('delivered');
    const tip = await git('rev-parse', 'HEAD');
    expect((await h.run()).resolved).toBe(true);
    expect(await git('rev-parse', 'HEAD')).toBe(tip);
    expect(openMerge).toHaveBeenCalledTimes(1);
    expect(h.checkpoints).toEqual(['level-0']);
    expect(await loadDagOutcomeCounts(h.db, 'task')).toEqual({
      total: 2,
      split: 0,
      merged: 1,
      noChange: 1,
      failed: 0,
      refused: 0,
      blocked: 0,
      skipped: 0,
      unconfirmed: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([undefined, 'fail-step', 'record-and-continue'])(
  'apply publishes counts only for the opt-in policy (%s)',
  async (policy) => {
    const h = fixture([issue('D', { mergeStatus: 'clean', mergedAt: new Date() })]);
    h.levels[0].checkpointedAt = new Date();
    Object.assign(h.step, {
      taskId: 'task',
      stepId: 'custom.execute',
      detectOutput: {},
      formSchema: null,
      formValues: null,
    });
    Object.assign(h.stepDef, { apply: async () => ({ ran: true }) });
    h.stepDef.dagExecute.failurePolicy = policy as string;
    const result = await advanceStep({
      ...h.params,
      db: h.db,
      repoPath: '/repo',
      workspacePath: '/repo',
      stepDef: h.stepDef,
      moduleDeactivation: null,
    } as never);
    expect(result.status).toBe('done');
    if (policy === 'record-and-continue')
      expect(h.step.output).toMatchObject({
        ran: true,
        dagOutcomes: { total: 1, merged: 1, failed: 0, refused: 0, blocked: 0, noChange: 0 },
      });
    else expect(h.step.output).toEqual({ ran: true });
  },
);

it.each(['fail-step', 'record-and-continue'])(
  'handles an unresolved failure on the escalation re-read under %s',
  async (policy) => {
    const h = fixture(
      [
        issue('A', { resolution: 'approved' }),
        issue('B', failure),
        issue('D', { resolution: 'approved' }),
      ],
      true,
    );
    h.stepDef.dagExecute.failurePolicy = policy;
    const r = await h.escalate([
      issue('A', { ...failure, lastAdvisorAction: 'ESCALATE_TO_REPLAN' }),
    ]);
    expect(r.status).toBe(policy === 'record-and-continue' ? 'ok' : 'aborted');
    expect(h.enqueued).toEqual([]);
    if (policy === 'record-and-continue') {
      expect((await h.run()).resolved).toBe(true);
      expect(openMerge).toHaveBeenCalledTimes(2);
    }
  },
);

for (const policy of ['fail-step', 'record-and-continue'] as const) {
  it('keeps missing coder configuration hard under ' + policy, async () => {
    const h = fixture([issue('A', { outcome: 'pending' })]);
    h.stepDef.dagExecute.failurePolicy = policy;
    vi.mocked(resolveTaskDispatch).mockResolvedValue({
      mode: 'skip',
      reason: 'no configuration',
    } as never);
    expect((await h.run()).resolved).toBe(false);
    expect(h.step.errorMessage).toContain('no cli provider available');
    expect(h.checkpoints).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });
  it('F5 bounds provider diagnostics to fifty under ' + policy, async () => {
    const h = fixture([issue('D')]);
    h.stepDef.dagExecute.failurePolicy = policy;
    for (let i = 0; i < 50; i++)
      h.invocations.push({
        id: `benign-${i}`,
        taskStepId: 'step',
        endedAt: new Date(100 - i),
        errorMessage: 'ordinary diagnostic',
      });
    h.invocations.push({
      id: 'fatal',
      taskStepId: 'step',
      endedAt: new Date(1),
      errorMessage: PROVIDER_FATAL_HEADLINES.auth,
    });
    expect((await h.run()).resolved).toBe(true);
    expect(h.step.errorMessage).toBeUndefined();
    expect(openMerge).toHaveBeenCalledTimes(1);
  });
}

it.each(['before result write', 'after result write'])(
  'recovers coder ingestion %s without another coder',
  async (point) => {
    const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'coder' })]);
    h.invocations.push({
      id: 'coder',
      startedAt: new Date(),
      endedAt: new Date(),
      exitCode: 0,
      parsedOutput: {
        issue_id: 'A',
        outcome: 'completed',
        concerns: '',
        files_modified: ['a.ts'],
        debt_items: [],
      },
    });
    h.fault((table, patch) => {
      if (
        (point === 'before result write' &&
          table === schema.taskDagIssues &&
          patch.outcome === 'completed') ||
        (point === 'after result write' && table === schema.cliInvocations && patch.consumedAt)
      )
        throw new Error('ingest crash');
    });
    await expect(h.run()).rejects.toThrow('ingest crash');
    h.fault();
    expect((await h.run()).resolved).toBe(true);
    expect(h.enqueued).toEqual([]);
    expect(openMerge).toHaveBeenCalledTimes(1);
  },
);

it('blocks a dependent when an advisor is the first agent refused, while later independent work merges', async () => {
  const h = fixture(
    [
      issue('A', failure),
      issue('B', {
        level: 1,
        outcome: 'pending',
        worktreePath: null,
        branchName: null,
        dependsOn: ['A'],
      }),
      issue('D', { level: 1, resolution: 'approved' }),
    ],
    true,
  );
  h.invocations.push({
    id: 'advisor-refused',
    startedAt: new Date(),
    endedAt: new Date(),
    exitCode: 1,
    errorMessage: PROVIDER_FATAL_HEADLINES.content_filter,
  });
  h.runs.push({
    id: 'advice',
    dagIssueId: 'A',
    role: 'issue_advisor',
    cliInvocationId: 'advisor-refused',
    consumedAt: null,
  });
  expect((await h.run()).resolved).toBe(true);
  expect(issueBlocked(h.rows[1] as never)).toBe(true);
  expect(h.runs[0]).toMatchObject({ status: 'done', consumedAt: expect.any(Date) });
  expect(h.enqueued).toEqual([]);
  expect(vi.mocked(openMerge).mock.calls.map((c) => c[1])).toEqual(['feature--D']);
});

for (const policy of ['fail-step', 'record-and-continue'] as const) {
  if (policy === 'record-and-continue')
    it.each(['advisor', 'replanner'])(
      'does not interpret a started %s crash as a legitimate decision under ' + policy,
      async (role) => {
        const h = fixture([issue('A', failure)], true);
        h.stepDef.dagExecute.failurePolicy = policy;
        h.invocations.push({
          id: 'crashed',
          startedAt: new Date(),
          endedAt: new Date(),
          exitCode: 137,
          errorMessage: null,
          parsedOutput: null,
        });
        if (role === 'replanner') h.plan.replannerInvocationId = 'crashed';
        else
          h.runs.push({
            id: 'advice',
            dagIssueId: 'A',
            role: 'issue_advisor',
            cliInvocationId: 'crashed',
            consumedAt: null,
          });
        await expect(h.run()).rejects.toThrow(/interrupted/);
        expect(h.plan.replannerInvocations).toBe(0);
        expect(h.checkpoints).toEqual([]);
        expect(h.enqueued).toEqual([]);
      },
    );
}

for (const policy of ['fail-step', 'record-and-continue']) {
  for (const role of ['advisor', 'replanner']) {
    it.each(['permission denied', PROVIDER_FATAL_HEADLINES.server_error])(
      `F1 frees a superseded ${role} after Retry under ${policy}: %s`,
      async (errorMessage) => {
        const h = fixture([issue('A', failure)], true);
        h.stepDef.dagExecute.failurePolicy = policy;
        h.invocations.push({
          id: 'old',
          startedAt: new Date(),
          endedAt: new Date(),
          supersededAt: new Date(),
          exitCode: 1,
          errorMessage,
        });
        if (role === 'replanner') {
          h.plan.replannerInvocationId = 'old';
          h.rows[0]!.lastAdvisorAction = 'ESCALATE_TO_REPLAN';
          expect((await h.escalate()).status).toBe('reloop');
          expect(h.plan.replannerInvocationId).toBeNull();
          expect(h.invocations[0]!.consumedAt).toBeInstanceOf(Date);
        } else {
          h.runs.push({
            id: 'old-advice',
            dagIssueId: 'A',
            role: 'issue_advisor',
            cliInvocationId: 'old',
            consumedAt: null,
          });
        }
        expect((await h.escalate()).status).toBe('waiting');
        expect(h.enqueued).toHaveLength(1);
        expect(h.enqueued[0]!.invocationId).not.toBe('old');
        expect(h.rows[0]!.advisorInvocations).toBe(0);
        expect(h.plan.replannerInvocations).toBe(0);
      },
    );
  }
}

for (const policy of [undefined, 'fail-step']) {
  it.each(['reviewer', 'issue_advisor', 'replanner'])(
    `F2 default equivalence: missing %s under ${policy}`,
    async (role) => {
      const h = fixture([issue('A', role === 'reviewer' ? {} : failure)], true);
      h.stepDef.dagExecute.failurePolicy = policy as string;
      if (role === 'replanner') h.rows[0]!.lastAdvisorAction = 'ESCALATE_TO_REPLAN';
      // The selected role is absent; the next role remains available.
      vi.mocked(resolveTaskDispatch).mockResolvedValueOnce({
        mode: 'skip',
        reason: 'disabled',
      } as never);
      const result = await h.run();
      expect(result.resolved).toBe(false);
      expect(h.rows[0]!.resolution).toBe('failed_unrecoverable');
      expect(h.rows[0]!.concerns).toBe('');
      expect(h.checkpoints).toEqual([]);
      if (role === 'replanner') {
        expect(h.step.status).toBe('failed');
        expect(h.step.errorMessage).toBe(
          'DAG escalation aborted at level 0: no replanner provider available (A)',
        );
        expect(h.enqueued).toEqual([]);
      } else {
        expect(h.step.status).toBe('waiting_cli');
        expect(h.enqueued).toHaveLength(1);
        expect(h.plan.replannerInvocationId !== null).toBe(role === 'issue_advisor');
      }
    },
  );
}

for (const policy of [undefined, 'fail-step', 'record-and-continue']) {
  for (const role of ['advisor', 'replanner']) {
    it.each([
      { exitCode: 1, errorMessage: 'permission denied' },
      { exitCode: 137, errorMessage: null },
      { exitCode: 143, errorMessage: 'CLI process exceeded its time budget' },
      { exitCode: null, errorMessage: 'orphaned by a worker restart' },
    ])(`F3 auxiliary fallback: ${role} under ${policy}: %j`, async (signal) => {
      const h = fixture([issue('A', failure)], true);
      h.stepDef.dagExecute.failurePolicy = policy as string;
      h.invocations.push({ id: 'aux', startedAt: new Date(), endedAt: new Date(), ...signal });
      if (role === 'replanner') h.plan.replannerInvocationId = 'aux';
      else
        h.runs.push({
          id: 'advice',
          dagIssueId: 'A',
          role: 'issue_advisor',
          cliInvocationId: 'aux',
          consumedAt: null,
        });
      if (policy === 'record-and-continue') {
        await expect(h.escalate()).rejects.toThrow(/DAG required agent/);
        expect(h.enqueued).toEqual([]);
        expect(h.plan.replannerInvocations).toBe(0);
      } else if (role === 'advisor') {
        expect((await h.escalate()).status).toBe('waiting');
        expect(h.rows[0]!.lastAdvisorAction).toBe('ESCALATE_TO_REPLAN');
        expect(h.rows[0]!.advisorInvocations).toBe(1);
        expect(h.plan.replannerInvocationId).not.toBeNull();
        expect(h.enqueued).toHaveLength(1);
      } else {
        const result = await h.escalate();
        expect(result.status).toBe('aborted');
        expect(result.error).toBe('DAG aborted by replanner at level 0: A');
        expect(h.step.status).toBe('failed');
        expect(h.plan.replannerInvocations).toBe(1);
        expect(h.plan.replannerInvocationId).toBeNull();
        expect(h.enqueued).toEqual([]);
      }
      expect(h.rows[0]!.concerns).toBe('');
      expect(h.checkpoints).toEqual([]);
    });
  }
}

it.each([undefined, 'fail-step'])(
  'F4 default equivalence: refused advisor escalates under %s',
  async (policy) => {
    const h = fixture([issue('A', failure)], true);
    h.stepDef.dagExecute.failurePolicy = policy as string;
    h.invocations.push({
      id: 'refused',
      startedAt: new Date(),
      endedAt: new Date(),
      exitCode: 1,
      errorMessage: PROVIDER_FATAL_HEADLINES.content_filter,
    });
    h.runs.push({
      id: 'advice',
      dagIssueId: 'A',
      role: 'issue_advisor',
      cliInvocationId: 'refused',
      consumedAt: null,
    });
    expect((await h.run()).resolved).toBe(false);
    expect(h.step.status).toBe('waiting_cli');
    expect(h.rows[0]!.lastAdvisorAction).toBe('ESCALATE_TO_REPLAN');
    expect(h.rows[0]!.errorMessage).toBeNull();
    expect(h.rows[0]!.advisorInvocations).toBe(1);
    expect(h.plan.replannerInvocationId).not.toBeNull();
    expect(h.enqueued).toHaveLength(1);
  },
);

it('F4 re-dispatches a superseded refused advisor under opt-in', async () => {
  const h = fixture([issue('A', failure)], true);
  h.invocations.push({
    id: 'refused',
    startedAt: new Date(),
    endedAt: new Date(),
    supersededAt: new Date(),
    exitCode: 1,
    errorMessage: PROVIDER_FATAL_HEADLINES.content_filter,
  });
  h.runs.push({
    id: 'advice',
    dagIssueId: 'A',
    role: 'issue_advisor',
    cliInvocationId: 'refused',
    consumedAt: null,
  });
  expect((await h.escalate()).status).toBe('waiting');
  expect(h.rows[0]!.advisorInvocations).toBe(0);
  expect(h.rows[0]!.errorMessage).toBeNull();
  expect(h.enqueued).toHaveLength(1);
  expect(h.plan.replannerInvocationId).toBeNull();
});

it.each([
  ['failed', { ...failure, concerns: DAG_FINAL_FAILURE_MARKER }],
  ['refused', { ...failure, errorMessage: PROVIDER_FATAL_HEADLINES.content_filter }],
  ['blocked', { ...failure, concerns: `${DAG_BLOCKED_BY_MARKER}["X"]` }],
  ['skipped', { resolution: 'skipped' }],
  ['no-change', { concerns: DAG_NO_CHANGE_MARKER, resolution: 'approved' }],
  ['nested split', { ...failure, concerns: DAG_FINAL_FAILURE_MARKER }],
])('F6 blocks split-parent dependents when a child is %s', async (kind, childPatch) => {
  const h = fixture(
    [
      issue('A', { id: 'parent-id', ...failure, resolution: 'split' }),
      issue('A-S1', {
        id: 'child-id',
        parentIssueId: 'parent-id',
        ...(childPatch as Row),
        ...(kind === 'nested split' ? { resolution: 'split', concerns: '' } : {}),
      }),
      ...(kind === 'nested split'
        ? [
            issue('A-S1-S1', {
              parentIssueId: 'child-id',
              ...failure,
              concerns: DAG_FINAL_FAILURE_MARKER,
            }),
          ]
        : []),
      issue('A-S2', {
        parentIssueId: 'parent-id',
        resolution: 'approved',
        mergeStatus: 'clean',
        mergedAt: new Date(),
      }),
      issue('B', {
        level: 1,
        outcome: 'pending',
        worktreePath: null,
        branchName: null,
        dependsOn: ['A'],
      }),
      issue('C', {
        level: 2,
        outcome: 'pending',
        worktreePath: null,
        branchName: null,
        dependsOn: ['B'],
      }),
      issue('D', { level: 1, resolution: 'approved' }),
    ],
    true,
  );
  h.levels[0].checkpointedAt = new Date();
  expect((await h.run()).resolved).toBe(true);
  expect(
    h.rows.filter((i) => ['B', 'C'].includes(i.issueKey)).every((i) => issueBlocked(i as never)),
  ).toBe(true);
  expect(h.rows.find((i) => i.issueKey === 'B')!.concerns).toBe(`${DAG_BLOCKED_BY_MARKER}["A"]`);
  expect(h.rows[0]!.resolution).toBe('split');
  expect(h.enqueued).toEqual([]);
  expect(
    vi
      .mocked(gitRun)
      .mock.calls.some(([, args]) => args.includes('add') && args.includes('worktree')),
  ).toBe(false);
  expect(vi.mocked(openMerge).mock.calls.map((c) => c[1])).toEqual(['feature--D']);
});

it('F6 keeps a split parent available when all children merged', async () => {
  const h = fixture(
    [
      issue('A', { id: 'parent-id', ...failure, resolution: 'split' }),
      issue('A-S1', {
        parentIssueId: 'parent-id',
        resolution: 'approved',
        mergeStatus: 'clean',
        mergedAt: new Date(),
      }),
      issue('B', { level: 1, outcome: 'pending', dependsOn: ['A'] }),
    ],
    true,
  );
  h.levels[0].checkpointedAt = new Date();
  expect((await h.run()).resolved).toBe(false);
  expect(h.rows[2]!.outcome).toBe('running');
  expect(issueBlocked(h.rows[2] as never)).toBe(false);
  expect(h.enqueued).toHaveLength(1);
});

it('F7 counts split parents separately from their delivered and failed children', async () => {
  const h = fixture([
    issue('A', { ...failure, resolution: 'split' }),
    issue('A-S1', { ...failure, resolution: 'split', parentIssueId: 'A' }),
    issue('A-S1-S1', { ...failure, parentIssueId: 'A-S1', concerns: DAG_FINAL_FAILURE_MARKER }),
    issue('A-S2', { parentIssueId: 'A', mergeStatus: 'clean', mergedAt: new Date() }),
    issue('D', { mergeStatus: 'resolved', mergedAt: new Date() }),
  ]);
  const counts = await loadDagOutcomeCounts(h.db, 'task');
  expect(counts).toEqual({
    total: 5,
    split: 2,
    merged: 2,
    failed: 1,
    refused: 0,
    blocked: 0,
    noChange: 0,
    skipped: 0,
    unconfirmed: 0,
  });
  expect(
    Object.entries(counts)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, count]) => sum + count, 0),
  ).toBe(counts.total);
});

for (const policy of [undefined, 'fail-step', 'record-and-continue']) {
  it.each([
    { parsedOutput: null, rawOutput: 'no structured reply' },
    { parsedOutput: { action: 'UNKNOWN' }, rawOutput: null },
    { parsedOutput: {}, rawOutput: null },
  ])(`F9 malformed replanner under ${policy}: %j`, async (output) => {
    const h = fixture([issue('A', { ...failure, lastAdvisorAction: 'ESCALATE_TO_REPLAN' })], true);
    h.stepDef.dagExecute.failurePolicy = policy as string;
    h.plan.replannerInvocationId = 'malformed';
    h.invocations.push({
      id: 'malformed',
      startedAt: new Date(),
      endedAt: new Date(),
      exitCode: 0,
      errorMessage: null,
      ...output,
    });
    if (policy === 'record-and-continue') {
      await expect(h.escalate()).rejects.toThrow(/replanner.*no valid structured decision/i);
      expect(h.plan.replannerInvocationId).toBe('malformed');
      expect(h.plan.replannerInvocations).toBe(0);
      expect(h.invocations[0]!.consumedAt).toBeUndefined();
      expect(h.rows[0]!.concerns).toBe('');
      // A user Retry can replace this hard-faulted run using the free-slot path.
      h.invocations[0]!.supersededAt = new Date();
      expect((await h.escalate()).status).toBe('reloop');
      expect((await h.escalate()).status).toBe('waiting');
      expect(h.enqueued).toHaveLength(1);
    } else {
      const result = await h.escalate();
      expect(result.status).toBe('aborted');
      expect(result.error).toBe('DAG aborted by replanner at level 0: A');
      expect(h.plan.replannerInvocations).toBe(1);
    }
    expect(h.checkpoints).toEqual([]);
  });
}

it('F9 keeps explicit structured ABORT recordable even with fallback-like reasoning', async () => {
  const h = fixture([issue('A', failure)], true);
  h.plan.replannerInvocationId = 'decline';
  h.invocations.push({
    id: 'decline',
    startedAt: new Date(),
    endedAt: new Date(),
    exitCode: 0,
    parsedOutput: {
      action: 'ABORT',
      reasoning: 'replanner returned no valid structured decision',
      skip_downstream: [],
      new_levels: [],
    },
  });
  expect((await h.run()).resolved).toBe(true);
  expect(h.rows[0]!.concerns).toContain(DAG_FINAL_FAILURE_MARKER);
  expect(h.plan.replannerInvocations).toBe(1);
});

for (const policy of [undefined, 'fail-step', 'record-and-continue']) {
  it.each([
    { parsedOutput: null, rawOutput: 'no structured reply' },
    { parsedOutput: { action: 'UNKNOWN' }, rawOutput: null },
  ])(`F9 malformed advisor under ${policy}: %j`, async (output) => {
    const h = fixture([issue('A', failure)], true);
    h.stepDef.dagExecute.failurePolicy = policy as string;
    h.invocations.push({
      id: 'malformed-advisor',
      startedAt: new Date(),
      endedAt: new Date(),
      exitCode: 0,
      errorMessage: null,
      ...output,
    });
    h.runs.push({
      id: 'advice',
      dagIssueId: 'A',
      role: 'issue_advisor',
      cliInvocationId: 'malformed-advisor',
      consumedAt: null,
    });
    if (policy === 'record-and-continue') {
      await expect(h.escalate()).rejects.toThrow(/advisor.*no valid structured decision/i);
      expect(h.runs[0]!.consumedAt).toBeNull();
      expect(h.rows[0]!.advisorInvocations).toBe(0);
      expect(h.enqueued).toEqual([]);
    } else {
      expect((await h.escalate()).status).toBe('waiting');
      expect(h.rows[0]!.lastAdvisorAction).toBe('ESCALATE_TO_REPLAN');
      expect(h.rows[0]!.advisorInvocations).toBe(1);
      expect(h.plan.replannerInvocationId).not.toBeNull();
    }
    expect(h.rows[0]!.concerns).toBe('');
    expect(h.checkpoints).toEqual([]);
  });
}

for (const role of ['reviewer', 'coder'] as const) {
  it.each([
    { exitCode: 1, errorMessage: 'permission denied' },
    { exitCode: 1, errorMessage: PROVIDER_FATAL_HEADLINES.server_error },
    { exitCode: 137, errorMessage: null },
    { exitCode: 143, errorMessage: 'CLI process exceeded its time budget' },
    { exitCode: null, errorMessage: 'orphaned by a worker restart' },
  ])(`DAGP-1 opt-in ${role} stops before consuming a hard fault: %j`, async (signal) => {
    const h = fixture([issue('A')], true);
    const run = { id: 'review-run', role, consumedAt: null };
    h.runs.push(run);
    const inv = { id: 'fault', startedAt: new Date(), endedAt: new Date(), ...signal };
    await expect(
      ingestReviewRun(
        {
          db: h.db,
          current: h.step,
          level: h.levels[0],
          stepDef: h.stepDef,
          specView: { text: '', condensed: false },
        } as never,
        h.rows[0] as never,
        run as never,
        inv as never,
      ),
    ).rejects.toThrow(/DAG required agent/);
    expect(run.consumedAt).toBeNull();
    expect(h.rows[0]!.resolution).toBeNull();
    expect(h.enqueued).toEqual([]);
  });

  it.each(['superseded', 'never-started', 'truncated'])(
    `DAGP-1 opt-in ${role} preserves free %s redispatch`,
    async (kind) => {
      const h = fixture([issue('A')], true);
      const run = { id: 'review-run', role, consumedAt: null };
      h.runs.push(run);
      const inv = {
        id: 'old',
        startedAt: kind === 'never-started' ? null : new Date(),
        endedAt: new Date(),
        exitCode: 137,
        supersededAt: kind === 'superseded' ? new Date() : null,
        errorMessage: kind === 'truncated' ? OUTPUT_TRUNCATION_HEADLINE : null,
        truncationRetry: false,
      };
      await ingestReviewRun(
        {
          db: h.db,
          current: h.step,
          level: h.levels[0],
          stepDef: h.stepDef,
          specView: { text: '', condensed: false },
          params: h.params,
          providers: [],
          deps: h.params.deps,
          taskId: 'task',
          attachmentsNotice: '',
        } as never,
        h.rows[0] as never,
        run as never,
        inv as never,
      );
      expect(h.enqueued).toHaveLength(1);
      expect(h.rows[0]!.reviewInfraRetries).toBe(0);
      expect(h.rows[0]!.resolution).toBeNull();
      if (kind === 'truncated') expect(h.invocations[0]!.truncationRetry).toBe(true);
    },
  );
}

function auxiliaryHarness(role: 'issue_advisor' | 'replanner' | 'reviewer' | 'coder') {
  const h = fixture([issue('A', role === 'reviewer' || role === 'coder' ? {} : failure)], true);
  const args = () => ({
    db: h.db,
    current: h.step,
    plan: { ...h.plan },
    level: h.levels[0],
    stepDef: h.stepDef,
    specView: { text: '', condensed: false },
    params: h.params,
    providers: [],
    deps: h.params.deps,
    taskId: 'task',
    attachmentsNotice: '',
    issues: h.rows,
  });
  const fold = (inv: Row) => {
    const run = { id: `run-${inv.id}`, dagIssueId: 'A', role, consumedAt: null };
    h.runs.push(run);
    h.invocations.push(inv);
    if (role === 'replanner') {
      h.plan.replannerInvocationId = inv.id;
      return h.escalate();
    }
    return (role === 'issue_advisor' ? ingestAdvisor : ingestReviewRun)(
      args() as never,
      h.rows[0] as never,
      run as never,
      inv as never,
    );
  };
  return { ...h, fold, args };
}
const auxiliaryFault = (id: string, patch: Row = {}): Row => ({
  id,
  cliProviderId: 'provider',
  startedAt: new Date(),
  endedAt: new Date(),
  exitCode: 1,
  errorMessage: 'permission denied',
  ...patch,
});

for (const role of ['issue_advisor', 'replanner', 'reviewer', 'coder'] as const) {
  it(`DGL-4 ${role} rejects a truncated structured result followed by a kill`, async () => {
    const h = auxiliaryHarness(role);
    const output =
      role === 'issue_advisor'
        ? { action: 'ESCALATE_TO_REPLAN', reasoning: 'needs planning' }
        : role === 'replanner'
          ? { action: 'CONTINUE', reasoning: 'proceed' }
          : role === 'reviewer'
            ? { verdict: 'approve', criteria_results: [], issues: [] }
            : { issue_id: 'A', outcome: 'completed', files_modified: ['a.ts'] };
    // The closing object bracket was never printed. Do not repair a killed partial reply.
    const inv = auxiliaryFault('partial-then-kill', {
      exitCode: 137,
      errorMessage: null,
      parsedOutput: null,
      rawOutput: '```json\n' + JSON.stringify(output).slice(0, -1),
    });
    const streak = {
      kind: 'dag_auxiliary_faults',
      role,
      level: 0,
      providerId: 'provider',
      invocationId: 'earlier-fault',
      count: 1,
    };
    h.plan.escalationLog = [streak];
    await expect(h.fold(inv)).rejects.toThrow(/interrupted.*Retry to recover/);
    expect(h.runs[0]!.consumedAt).toBeNull();
    expect(inv.consumedAt).toBeUndefined();
    expect(h.plan.escalationLog).toEqual([streak]);
    expect(h.rows[0]!.advisorInvocations).toBe(0);
    expect(h.plan.replannerInvocations).toBe(0);
    expect(h.rows[0]!.resolution).toBe(
      role === 'issue_advisor' || role === 'replanner' ? 'failed_unrecoverable' : null,
    );
    expect(h.enqueued).toEqual([]);
    expect(h.checkpoints).toEqual([]);
  });
}

it('DGL-4 section C also rejects a truncated fix-coder result followed by a kill', async () => {
  const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'fix' })], true);
  h.invocations.push(
    auxiliaryFault('fix', {
      exitCode: 137,
      errorMessage: null,
      parsedOutput: null,
      rawOutput: '```json\n{"issue_id":"A","outcome":"completed","files_modified":[',
    }),
  );
  h.runs.push({
    id: 'fix-run',
    dagIssueId: 'A',
    role: 'coder',
    cliInvocationId: 'fix',
    consumedAt: null,
  });
  await expect(h.run()).rejects.toThrow(/interrupted.*Retry to recover/);
  expect(h.rows[0]!.outcome).toBe('running');
  expect(h.invocations[0]!.consumedAt).toBeUndefined();
  expect(h.plan.escalationLog ?? []).toEqual([]);
  expect(h.enqueued).toEqual([]);
});

for (const role of ['issue_advisor', 'replanner', 'reviewer', 'coder'] as const) {
  it.each([false, true])(
    `DGL-3 ${role} content refusal neither counts nor clears (prior fault: %s)`,
    async (priorFault) => {
      const h = auxiliaryHarness(role);
      if (priorFault) await expect(h.fold(auxiliaryFault('first'))).rejects.toThrow(/DAG required/);
      const streak = structuredClone(h.plan.escalationLog ?? []);
      await h.fold(
        auxiliaryFault('refusal', { errorMessage: PROVIDER_FATAL_HEADLINES.content_filter }),
      );
      expect(h.plan.escalationLog ?? []).toEqual(streak);
      expect(h.rows[0]!.resolution).toBe('failed_unrecoverable');
      expect(h.enqueued).toEqual([]);
      // A later fault must extend the old streak, rather than start over after a refusal.
      await expect(h.fold(auxiliaryFault('after-refusal'))).rejects.toThrow(
        priorFault ? /switch the step's CLI/ : /DAG required agent failed/,
      );
      expect(h.plan.escalationLog).toEqual([
        expect.objectContaining({ role, count: priorFault ? 2 : 1 }),
      ]);
    },
  );

  const faults =
    role === 'issue_advisor' || role === 'replanner'
      ? ['environment', 'timeout', 'malformed']
      : ['environment', 'timeout'];
  it.each(faults)(`DAGP-2 ${role} bounds consecutive %s faults across Retry`, async (fault) => {
    const h = auxiliaryHarness(role);
    const signal =
      fault === 'malformed'
        ? { exitCode: 0, errorMessage: null, rawOutput: 'bad decision' }
        : fault === 'timeout'
          ? { exitCode: 137, errorMessage: 'CLI process exceeded its time budget' }
          : {};
    const first = auxiliaryFault('first', signal);
    await expect(h.fold(first)).rejects.toThrow(/DAG required/);
    // Redelivery of this invocation must not spend the second fault.
    await expect(h.fold(first)).rejects.toThrow(/DAG required/);
    expect(h.plan.escalationLog).toEqual([expect.objectContaining({ role, level: 0, count: 1 })]);
    // Retry supersedes old invocations, but preserves the plan log (unlike issue budgets).
    first.supersededAt = new Date();
    await expect(h.fold(auxiliaryFault('second', signal))).rejects.toThrow(
      /switch the step's CLI/i,
    );
    expect(h.plan.escalationLog).toEqual([expect.objectContaining({ role, level: 0, count: 2 })]);
    expect(h.rows[0]!.advisorInvocations).toBe(0);
    expect(h.plan.replannerInvocations).toBe(0);
    expect(h.checkpoints).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it(`DAGP-2 ${role} does not charge provider outages`, async () => {
    const h = auxiliaryHarness(role);
    for (const id of ['outage-1', 'outage-2', 'outage-3']) {
      await expect(
        h.fold(auxiliaryFault(id, { errorMessage: PROVIDER_FATAL_HEADLINES.server_error })),
      ).rejects.toThrow(/DAG required agent failed/);
    }
    expect(h.plan.escalationLog ?? []).toEqual([]);
  });
}

it('DGL-1 a refused replanner consumes its invocation before writing issues, matching Retry', async () => {
  const h = auxiliaryHarness('replanner');
  await h.fold(
    auxiliaryFault('refused', { errorMessage: PROVIDER_FATAL_HEADLINES.content_filter }),
  );
  const invocationWrite = h.operations.findIndex(
    (o) => o.kind === 'write' && o.table === schema.cliInvocations,
  );
  const issueWrite = h.operations.findIndex(
    (o) => o.kind === 'write' && o.table === schema.taskDagIssues,
  );
  expect(invocationWrite).toBeGreaterThanOrEqual(0);
  expect(issueWrite).toBeGreaterThan(invocationWrite);
});

it('DAGP-2 a refused replanner records affected issues and never resends', async () => {
  const h = auxiliaryHarness('replanner');
  h.rows.push(issue('D', { resolution: 'approved' }));
  expect(
    await h.fold(
      auxiliaryFault('refused', { errorMessage: PROVIDER_FATAL_HEADLINES.content_filter }),
    ),
  ).toMatchObject({ status: 'ok' });
  expect(h.plan.replannerInvocationId).toBeNull();
  expect(h.invocations[0]!.consumedAt).toBeInstanceOf(Date);
  expect(h.rows[0]!.errorMessage).toBe(PROVIDER_FATAL_HEADLINES.content_filter);
  expect(h.rows[1]!.errorMessage).toBeNull();
  expect((await h.run()).resolved).toBe(true);
  expect((await h.run()).resolved).toBe(true);
  expect(h.enqueued).toEqual([]);
  expect((await loadDagOutcomeCounts(h.db, 'task')).refused).toBe(1);
});

for (const role of ['issue_advisor', 'replanner', 'reviewer', 'coder'] as const) {
  it(`DAGP-2 ${role} clears its streak after a valid reply`, async () => {
    const h = auxiliaryHarness(role);
    await expect(h.fold(auxiliaryFault('first'))).rejects.toThrow(/DAG required/);
    const parsedOutput =
      role === 'issue_advisor'
        ? { action: 'ESCALATE_TO_REPLAN', reasoning: 'needs planning' }
        : role === 'replanner'
          ? { action: 'CONTINUE', reasoning: 'proceed' }
          : role === 'reviewer'
            ? { verdict: 'approve', criteria_results: [], issues: [] }
            : { issue_id: 'A', outcome: 'completed', files_modified: ['a.ts'] };
    await h.fold(auxiliaryFault('valid', { exitCode: 0, errorMessage: null, parsedOutput }));
    expect(h.plan.escalationLog).toEqual([]);
    await expect(h.fold(auxiliaryFault('after-success'))).rejects.toThrow(/DAG required/);
    expect(h.plan.escalationLog).toEqual([expect.objectContaining({ role, count: 1 })]);
  });

  it(`DAGP-2 ${role} blocks the same CLI at its bound and permits a different CLI`, async () => {
    const h = auxiliaryHarness(role);
    await expect(h.fold(auxiliaryFault('first'))).rejects.toThrow(/DAG required/);
    await expect(h.fold(auxiliaryFault('second'))).rejects.toThrow(/switch the step's CLI/);
    // Simulate Retry's removal/superseding of the old runs, retaining the plan log.
    h.runs.splice(0);
    h.plan.replannerInvocationId = null;
    const spawn = () => {
      if (role === 'coder') {
        h.rows[0]!.stuckCount = 0;
        return ingestReviewRun(
          h.args() as never,
          h.rows[0] as never,
          { id: 'review-to-fix', role: 'reviewer' } as never,
          auxiliaryFault('review-to-fix', {
            exitCode: 0,
            errorMessage: null,
            parsedOutput: {
              verdict: 'fix_required',
              criteria_results: [],
              issues: [{ severity: 'high', file: 'a.ts', description: 'fix the stale cache' }],
            },
          }) as never,
        );
      }
      if (role === 'replanner') h.rows[0]!.lastAdvisorAction = 'ESCALATE_TO_REPLAN';
      return role === 'reviewer' ? h.run() : h.escalate();
    };
    await expect(spawn()).rejects.toThrow(/switch the step's CLI/);
    expect(h.enqueued).toEqual([]);
    vi.mocked(resolveTaskDispatch).mockResolvedValue({
      mode: 'cli',
      providerId: 'replacement',
      invocation: { kind: 'cli', spec: {} },
    } as never);
    // Retry resets the issue's review state too.
    h.rows[0]!.resolution = role === 'reviewer' || role === 'coder' ? null : 'failed_unrecoverable';
    await spawn();
    expect(h.enqueued).toHaveLength(1);
    // The new provider gets its own fault streak rather than inheriting the old bound.
    await expect(
      h.fold(auxiliaryFault('replacement-fault', { cliProviderId: 'replacement' })),
    ).rejects.toThrow(/DAG required agent failed/);
    expect(h.plan.escalationLog).toEqual([
      expect.objectContaining({ role, count: 1, providerId: 'replacement' }),
    ]);
  });
}

it('DAGP-2 fault streak writes roll back after ownership is lost', async () => {
  const h = auxiliaryHarness('issue_advisor');
  h.step.status = 'pending';
  await expect(h.fold(auxiliaryFault('lost'))).rejects.toThrow(StepSupersededError);
  expect(h.plan.escalationLog ?? []).toEqual([]);
});

it.each([
  { exitCode: 1, errorMessage: 'permission denied' },
  { exitCode: 137, errorMessage: null },
  { exitCode: 143, errorMessage: 'CLI process exceeded its time budget' },
])(
  'DAGP-2 an advisor-started fix coder is checked before section C redispatch: %j',
  async (signal) => {
    const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'fix' })], true);
    h.invocations.push(auxiliaryFault('fix', signal));
    h.runs.push({
      id: 'fix-run',
      dagIssueId: 'A',
      role: 'coder',
      cliInvocationId: 'fix',
      consumedAt: null,
    });
    await expect(h.run()).rejects.toThrow(/DAG required agent/);
    expect(h.invocations[0]!.consumedAt).toBeUndefined();
    expect(h.rows[0]!.outcome).toBe('running');
    expect(h.enqueued).toEqual([]);
    expect(h.plan.escalationLog ?? []).toEqual(
      signal.exitCode === 137 ? [] : [expect.objectContaining({ role: 'coder', count: 1 })],
    );
  },
);

for (const role of ['issue_advisor', 'replanner', 'reviewer', 'coder'] as const) {
  it.each([
    {
      exitCode: null,
      errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
    },
    { exitCode: 137, errorMessage: null },
    { exitCode: 143, errorMessage: 'cancelled' },
  ])(`DAGP-F1 ${role} interruptions never increment or block dispatch: %j`, async (signal) => {
    const h = auxiliaryHarness(role);
    for (const id of ['first', 'second', 'third']) {
      await expect(h.fold(auxiliaryFault(id, signal))).rejects.toThrow(
        /interrupted.*Retry to recover/,
      );
    }
    expect(h.plan.escalationLog ?? []).toEqual([]);
    expect(h.rows[0]!.reviewInfraRetries).toBe(0);
    expect(h.rows[0]!.infraRetries).toBe(0);
    expect(h.enqueued).toEqual([]);
    // Retry supersedes old invocations. Re-entry must still be able to dispatch this CLI.
    for (const inv of h.invocations) inv.supersededAt = new Date();
    if (role === 'reviewer') {
      h.runs.splice(0); // A fresh review; retained-run Retry is exercised separately under F3.
      await h.run();
    } else if (role === 'coder') {
      await ingestReviewRun(
        h.args() as never,
        h.rows[0] as never,
        { id: 'review', role: 'reviewer' } as never,
        auxiliaryFault('review', {
          exitCode: 0,
          errorMessage: null,
          parsedOutput: {
            verdict: 'fix_required',
            criteria_results: [],
            issues: [{ severity: 'high', file: 'a.ts', description: 'repair cache' }],
          },
        }) as never,
      );
    } else {
      h.plan.replannerInvocationId = null;
      h.runs.splice(0);
      if (role === 'replanner') h.rows[0]!.lastAdvisorAction = 'ESCALATE_TO_REPLAN';
      await h.escalate();
    }
    expect(h.enqueued).toHaveLength(1);
  });
}

it.each(['CONTINUE', 'ABORT'])(
  'DAGP-F2 replanner %s writes issues and invocation before locking the step to clear its streak',
  async (action) => {
    const h = auxiliaryHarness('replanner');
    await expect(h.fold(auxiliaryFault('first'))).rejects.toThrow(/DAG required/);
    h.operations.length = 0;
    await h.fold(
      auxiliaryFault('valid', {
        exitCode: 0,
        errorMessage: null,
        parsedOutput: { action, reasoning: 'proceed' },
      }),
    );
    const stepLock = h.operations.findIndex(
      (o) => o.kind === 'lock' && o.table === schema.taskSteps,
    );
    for (const table of [schema.cliInvocations, schema.taskDagIssues]) {
      const writes = h.operations.flatMap((o, i) =>
        o.kind === 'write' && o.table === table ? [i] : [],
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(Math.max(...writes)).toBeLessThan(stepLock);
    }
    expect(h.plan.escalationLog).toEqual([]);
  },
);

it.each([false, true])(
  'DAGP-F3 blocked reviewer survives repeated Retry (consumed=%s)',
  async (consumed) => {
    const h = auxiliaryHarness('reviewer');
    await expect(
      h.fold(
        auxiliaryFault('first', {
          exitCode: 137,
          errorMessage: 'CLI process exceeded its time budget',
        }),
      ),
    ).rejects.toThrow(/DAG required/);
    await expect(
      h.fold(
        auxiliaryFault('second', {
          exitCode: 137,
          errorMessage: 'CLI process exceeded its time budget',
        }),
      ),
    ).rejects.toThrow(/switch the step's CLI/);
    // A real Retry retains unconsumed reviewer runs and supersedes their invocations.
    for (const inv of h.invocations) inv.supersededAt = new Date();
    // The fake select keeps insertion order; keep only the actual latest run for this scenario.
    h.runs.shift();
    h.runs[0]!.cliInvocationId = 'second';
    if (consumed) h.runs[0]!.consumedAt = new Date();
    const originalConsumedAt = h.runs[0]!.consumedAt;
    for (let retry = 0; retry < 4; retry++) {
      await expect(resolveReviewPhase(h.args() as never)).rejects.toThrow(/switch the step's CLI/);
      expect(h.runs[0]!.consumedAt).toEqual(originalConsumedAt);
      expect(h.rows[0]!.reviewInfraRetries).toBe(0);
      expect(h.rows[0]!.resolution).toBeNull();
      expect(h.rows[0]!.errorMessage).toBeNull();
    }
    expect(h.enqueued).toEqual([]);
    vi.mocked(resolveTaskDispatch).mockResolvedValue({
      mode: 'cli',
      providerId: 'replacement',
      invocation: { kind: 'cli', spec: {} },
    } as never);
    await resolveReviewPhase(h.args() as never);
    expect(h.enqueued).toHaveLength(1);
  },
);

for (const role of ['reviewer', 'coder'] as const) {
  it.each([
    { exitCode: 137, errorMessage: null },
    { exitCode: 143, errorMessage: 'CLI process exceeded its time budget' },
    { exitCode: 1, errorMessage: 'permission denied' },
  ])(`DAGP-F5 ${role} uses a valid result before process failure: %j`, async (signal) => {
    const h = auxiliaryHarness(role);
    const output =
      role === 'reviewer'
        ? { verdict: 'approve', criteria_results: [], issues: [] }
        : { issue_id: 'A', outcome: 'completed', files_modified: ['a.ts'] };
    await h.fold(
      auxiliaryFault('result-then-kill', {
        ...signal,
        rawOutput: '```json\n' + JSON.stringify(output) + '\n```',
      }),
    );
    expect(h.runs[0]!.consumedAt).toBeInstanceOf(Date);
    expect(h.plan.escalationLog ?? []).toEqual([]);
    if (role === 'reviewer') expect(h.rows[0]!.resolution).toBe('approved');
    else expect(h.enqueued).toHaveLength(1); // Re-review the fix, rather than reject its output.
  });
}

it('DGL-2 a content-refused section C fix coder records the host refusal note in its ledger', async () => {
  const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'fix' })], true);
  h.invocations.push(
    auxiliaryFault('fix', {
      errorMessage: PROVIDER_FATAL_HEADLINES.content_filter,
      parsedOutput: {
        issue_id: 'A',
        outcome: 'completed',
        concerns: 'Coder claims all is well',
        files_modified: ['a.ts'],
      },
    }),
  );
  h.runs.push({ id: 'fix-run', dagIssueId: 'A', role: 'coder', cliInvocationId: 'fix' });
  await h.run();
  expect(h.rows[0]!.outcome).toBe('failed_unrecoverable');
  expect(h.rows[0]!.errorMessage).toBe(PROVIDER_FATAL_HEADLINES.content_filter);
  expect(h.rows[0]!.concerns).toContain('coder was refused by the provider');
  expect(recordLedgerEntry).toHaveBeenCalledWith(
    h.db,
    'task',
    'step',
    expect.objectContaining({ text: expect.stringContaining('coder was refused by the provider') }),
  );
  expect(h.enqueued).toEqual([]);
});

for (const outcome of ['completed', 'failed_unrecoverable'] as const) {
  it.each([
    { exitCode: 137, errorMessage: null },
    { exitCode: 143, errorMessage: 'CLI process exceeded its time budget' },
  ])(
    `DAGP-F5 advisor-started fix coder uses its valid ${outcome} result in section C: %j`,
    async (signal) => {
      const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'fix' })], true);
      h.invocations.push(
        auxiliaryFault('fix', {
          ...signal,
          parsedOutput: { issue_id: 'A', outcome, files_modified: ['a.ts'] },
        }),
      );
      h.runs.push({
        id: 'fix-run',
        dagIssueId: 'A',
        role: 'coder',
        cliInvocationId: 'fix',
        consumedAt: null,
      });
      await h.run();
      expect(h.rows[0]!.outcome).toBe(outcome);
      expect(h.invocations[0]!.consumedAt).toBeInstanceOf(Date);
      expect(h.plan.escalationLog ?? []).toEqual([]);
      expect(h.rows[0]!.infraRetries).toBe(0);
      expect(h.step.cliTimeoutLearnedMs).toBeUndefined();
    },
  );
}

for (const outcome of ['completed', 'failed_unrecoverable'] as const) {
  it.each([false, true])(
    `DAGP-F8 section C clears the coder streak on a valid ${outcome} fix result (refused: %s)`,
    async (refused) => {
      const h = fixture([issue('A', { outcome: 'running', cliInvocationId: 'fix' })], true);
      const streak = {
        kind: 'dag_auxiliary_faults',
        role: 'coder',
        level: 0,
        providerId: 'provider',
        invocationId: 'earlier-fault',
        count: 1,
      };
      h.plan.escalationLog = [streak];
      h.invocations.push(
        auxiliaryFault('fix', {
          exitCode: refused ? 1 : 0,
          errorMessage: refused ? PROVIDER_FATAL_HEADLINES.content_filter : null,
          parsedOutput: { issue_id: 'A', outcome, files_modified: ['a.ts'] },
        }),
      );
      h.runs.push({
        id: 'fix-run',
        dagIssueId: 'A',
        role: 'coder',
        cliInvocationId: 'fix',
        consumedAt: null,
      });
      await h.run();
      // A refusal is no usable reply: it neither counts nor clears.
      expect(h.plan.escalationLog ?? []).toEqual(refused ? [streak] : []);
    },
  );
}

for (const role of ['reviewer', 'coder', 'issue_advisor', 'replanner'] as const) {
  it(`DAGP-F6 ${role} skips the streak transaction when no entry exists`, async () => {
    const h = auxiliaryHarness(role);
    // Another role's entry must survive, and must not make this clear take a lock.
    h.plan.escalationLog = [
      { kind: 'dag_auxiliary_faults', role: 'unrelated', level: 0, count: 1 },
    ];
    const transaction = vi.spyOn(h.db, 'transaction');
    const parsedOutput =
      role === 'reviewer'
        ? { verdict: 'approve', criteria_results: [], issues: [] }
        : role === 'coder'
          ? { issue_id: 'A', outcome: 'completed', files_modified: ['a.ts'] }
          : {
              action: role === 'replanner' ? 'CONTINUE' : 'ESCALATE_TO_REPLAN',
              reasoning: 'proceed',
            };
    await h.fold(auxiliaryFault('valid', { exitCode: 0, errorMessage: null, parsedOutput }));
    expect(
      h.operations.filter((o) => o.kind === 'lock' && o.table === schema.taskDagPlans),
    ).toEqual([]);
    expect(h.plan.escalationLog).toEqual([
      { kind: 'dag_auxiliary_faults', role: 'unrelated', level: 0, count: 1 },
    ]);
    if (role === 'reviewer' || role === 'issue_advisor') expect(transaction).not.toHaveBeenCalled();
    if (role === 'replanner') expect(transaction).toHaveBeenCalledTimes(1); // Atomic decision only.
  });
}
