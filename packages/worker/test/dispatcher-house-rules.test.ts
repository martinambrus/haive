import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';

const h = vi.hoisted(() => ({
  context: undefined as unknown,
  asked: [] as Array<{ houseRules: boolean }>,
  recorded: [] as Array<{ taskId: string; errorClass: string }>,
}));

vi.mock('../src/orchestrator/global-kb-context.js', () => ({
  resolveGlobalKbContext: async (_db: unknown, _taskId: string, opts: { houseRules: boolean }) => {
    h.asked.push(opts);
    return h.context;
  },
}));
vi.mock('../src/orchestrator/house-rules-dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordHouseRulesUnavailable: async (_db: unknown, taskId: string, errorClass: string) => {
    h.recorded.push({ taskId, errorClass });
  },
}));

import { resolveTaskDispatch } from '../src/orchestrator/dispatcher.js';
import { HOUSE_RULES_MARKER, type HouseRuleCandidate } from '../src/orchestrator/house-rules.js';

const emptyDigest = { entries: [], omitted: 0, scanSaturated: false };
const context = (over: Record<string, unknown> = {}) => ({
  digest: emptyDigest,
  rules: [],
  refused: [],
  status: 'ok',
  ...over,
});

const rule = (title: string, over: Partial<HouseRuleCandidate> = {}): HouseRuleCandidate => ({
  id: '00000001-0000-4000-8000-000000000001',
  hash: 'hr1:1',
  title,
  category: 'best_practice',
  description: `About ${title}.`,
  body: `Body of ${title}.\n`,
  spec: { mode: 'always' },
  enforcedAt: null,
  ...over,
});

/** A task with no repository, which is all this needs: no tree to read, no boundary to claim. */
const db = {
  query: {
    tasks: { findFirst: async () => ({ envTemplateId: null, repositoryId: null }) },
    repositories: { findFirst: async () => undefined },
    taskSteps: { findFirst: async () => undefined },
    envTemplates: { findFirst: async () => undefined },
  },
  select: () => ({
    from: () => ({
      innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
    }),
  }),
} as unknown as Database;

const claude = {
  id: 'prov-claude',
  userId: 'user-1',
  name: 'claude-code',
  label: 'claude',
  executablePath: null,
  wrapperPath: null,
  envVars: null,
  cliArgs: null,
  supportsSubagents: true,
  authMode: 'subscription',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as CliProviderRecord;

const dispatch = async (extra: Record<string, unknown> = {}) => {
  const plan = await resolveTaskDispatch(db, 'task-1', {
    providers: [claude],
    input: { kind: 'prompt', prompt: 'do the work', capabilities: [] },
    invokeOpts: {},
    ...extra,
  });
  if (plan.invocation?.kind !== 'cli') throw new Error('expected a cli invocation');
  return { prompt: plan.effectivePrompt!, spec: plan.invocation.spec };
};

const opted = { houseRules: { mode: 'write' as const } };

beforeEach(() => {
  h.context = context();
  h.asked = [];
  h.recorded = [];
});

describe('resolveTaskDispatch and the house rules', () => {
  it('asks the store for rules only when the dispatch is opted in', async () => {
    await dispatch();
    await dispatch(opted);
    expect(h.asked).toEqual([{ houseRules: false }, { houseRules: true }]);
  });

  it('does not count a sub-agent dispatch as opted in', async () => {
    const spec: SubAgentSpec = {
      subAgents: [{ name: 'a', prompt: 'do a', outputKey: 'a' }],
      synthesisPrompt: 'sum up',
    };
    await resolveTaskDispatch(db, 'task-1', {
      providers: [claude],
      input: { kind: 'subagent', spec, capabilities: ['subagents'] },
      invokeOpts: {},
      ...opted,
    });
    expect(h.asked).toEqual([{ houseRules: false }]);
  });

  it('leaves the prompt of a dispatch that did not opt in as it was, whatever the store holds', async () => {
    const before = (await dispatch()).prompt;
    h.context = context({ rules: [rule('Alpha')] });
    const out = await dispatch();
    expect(out.prompt).toBe(before);
    expect(out.spec.houseRules).toBeUndefined();
  });

  it('shows an opted dispatch the rules the store returned, and records them', async () => {
    h.context = context({ rules: [rule('Alpha')] });
    const out = await dispatch(opted);
    expect(out.prompt.startsWith(HOUSE_RULES_MARKER)).toBe(true);
    expect(out.prompt).toContain('### Rule 00000001: Alpha');
    expect(out.spec.houseRules).toEqual({
      mode: 'write',
      entries: [
        {
          id: '00000001-0000-4000-8000-000000000001',
          hash: 'hr1:1',
          title: 'Alpha',
          why: { scope: 'always' },
        },
      ],
      omitted: [],
    });
    expect(h.recorded).toEqual([]);
  });

  it('shows a files rule unscoped when the task has no tree to read the change from', async () => {
    h.context = context({
      rules: [rule('Tpl', { spec: { mode: 'files', globs: ['**/*.tpl.php'] } })],
    });
    const out = await dispatch(opted);
    expect(out.spec.houseRules?.entries.map((e) => e.why)).toEqual([
      { scope: 'files', glob: null },
    ]);
  });

  it('counts the files an issue plans to touch', async () => {
    h.context = context({
      rules: [rule('Tpl', { spec: { mode: 'files', globs: ['**/*.tpl.php'] } })],
    });
    const out = await dispatch({
      houseRules: { mode: 'write', estimatedFiles: ['t/node.tpl.php'] },
    });
    expect(out.spec.houseRules?.entries).toHaveLength(1);
  });

  it('records the refused rows and shows nothing of them', async () => {
    const refused = [{ id: 'x', hash: 'h', title: 'Bad', why: 'refused' as const }];
    h.context = context({ refused });
    const out = await dispatch(opted);
    expect(out.prompt).not.toContain(HOUSE_RULES_MARKER);
    expect(out.spec.houseRules).toEqual({ mode: 'write', entries: [], omitted: refused });
  });

  it('records the switch being off, and writes no event for it', async () => {
    h.context = context({ status: 'disabled' });
    const out = await dispatch(opted);
    expect(out.spec.houseRules).toMatchObject({ reason: 'switched_off', entries: [] });
    expect(h.recorded).toEqual([]);
  });

  it('records an unreadable store by its class, writes the event once and sends the dispatch on', async () => {
    h.context = context({ status: 'unavailable', errorClass: 'timeout' });
    const out = await dispatch(opted);
    expect(out.prompt).not.toContain(HOUSE_RULES_MARKER);
    expect(out.spec.houseRules).toEqual({
      mode: 'write',
      entries: [],
      omitted: [],
      reason: 'unavailable',
      errorClass: 'timeout',
    });
    expect(h.recorded).toEqual([{ taskId: 'task-1', errorClass: 'timeout' }]);
  });

  it('writes no event for a dispatch that did not ask, even when the store is unreadable', async () => {
    h.context = context({ status: 'unavailable', errorClass: 'other' });
    await dispatch();
    expect(h.recorded).toEqual([]);
  });
});
