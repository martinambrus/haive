import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { CliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  buildFixLoopEscalationSchema,
  buildOscillationEscalationSchema,
  FIX_LOOP_TARGET_STEP_ID,
} from '../src/step-engine/steps/workflow/_fix-loop.js';
import {
  eligibleFixRoundProviders,
  FIX_ROUND_CLI_FIELD,
  fixRoundCliRole,
} from '../src/step-engine/steps/workflow/_fix-round-cli.js';

const provider = (id: string, over: Partial<CliProviderRecord> = {}): CliProviderRecord =>
  ({
    id,
    userId: 'owner',
    name: 'claude-code',
    label: id,
    enabled: true,
    authMode: 'subscription',
    envVars: null,
    cliArgs: null,
    createdAt: new Date(0),
    ...over,
  }) as CliProviderRecord;
const original = provider('original');
const picked = provider('picked');
const dialect = new PgDialect();

function database(
  choice?: string | null,
  fresh: CliProviderRecord | undefined = picked,
  laterChoice?: string | null,
) {
  return {
    query: {
      taskStepCliChoices: {
        findFirst: async ({ where }: { where: SQL }) => {
          const params = dialect.sqlToQuery(where).params;
          if (laterChoice !== undefined && params.includes('default'))
            return { role: 'default', cliProviderId: laterChoice, effortLevel: 'high' };
          return choice !== undefined && params.includes('fix:2:default')
            ? { role: fixRoundCliRole(2), cliProviderId: choice, effortLevel: null }
            : undefined;
        },
      },
      cliProviders: { findFirst: async () => fresh },
      userStepCliPreferences: {
        findFirst: async () => ({ cliProviderId: original.id, effortLevel: 'low' }),
      },
    },
  } as unknown as Database;
}

function resolve(db: Database, round: number, taskId = 'task', stepId = FIX_LOOP_TARGET_STEP_ID) {
  return resolvePreferredCli(
    db,
    'owner',
    stepId,
    null,
    [original, picked],
    'default',
    taskId,
    false,
    round,
  );
}

describe('next-round CLI', () => {
  it('leaves no-choice resolution exactly as before', async () => {
    const db = database();
    const today = await resolvePreferredCli(
      db,
      'owner',
      FIX_LOOP_TARGET_STEP_ID,
      null,
      [original, picked],
      'default',
      'task',
    );
    expect(await resolve(db, 2)).toEqual(today);
    expect(today).toEqual({ cliProviderId: original.id, effortLevel: 'low' });
  });

  it('uses the choice for its target round and default role, then expires', async () => {
    expect(fixRoundCliRole(2)).toBe('fix:2:default');
    expect(await resolve(database(picked.id), 2)).toMatchObject({
      cliProviderId: picked.id,
      roundProvider: picked,
    });
    expect(await resolve(database(picked.id), 3)).toEqual({
      cliProviderId: original.id,
      effortLevel: 'low',
    });
    expect(await resolve(database(picked.id), 2, 'task', '08b-test-management')).toEqual({
      cliProviderId: original.id,
      effortLevel: 'low',
    });
  });

  it.each([
    ['disabled', provider(picked.id, { enabled: false })],
    ['foreign', provider(picked.id, { userId: 'someone-else' })],
    ['deleted', null],
  ] as const)('refuses a %s provider instead of falling back', async (_reason, fresh) => {
    await expect(
      resolve(database(fresh ? picked.id : null, fresh ?? undefined), 2),
    ).rejects.toThrow(/next fix round.*(disabled|owned|deleted|available)/i);
  });

  it.each(['enabled', 'disabled', 'deleted'])(
    'honors a later step-card pick over an %s round provider',
    async (state) => {
      const fresh = provider(picked.id, { enabled: state !== 'disabled' });
      expect(
        await resolve(database(state === 'deleted' ? null : picked.id, fresh, original.id), 2),
      ).toEqual({ cliProviderId: original.id, effortLevel: 'high' });
    },
  );

  it('offers only eligible owned providers even though the implement step requiresCli is false', () => {
    expect(phase2ImplementStep.metadata.requiresCli).toBe(false);
    const candidates = [
      picked,
      provider('disabled', { enabled: false }),
      provider('foreign', { userId: 'someone-else' }),
      provider('unconfigured', { name: 'ollama' }),
    ];
    expect(eligibleFixRoundProviders('owner', candidates, phase2ImplementStep)).toEqual([picked]);
    const needsSubagents = {
      ...phase2ImplementStep,
      llm: { ...phase2ImplementStep.llm!, requiredCapabilities: ['subagents' as const] },
    };
    expect(
      eligibleFixRoundProviders(
        'owner',
        [provider('no-subagents', { name: 'codex' })],
        needsSubagents,
      ),
    ).toEqual([]);
  });

  it.each(['cap', 'oscillation'])(
    'offers the same scope and eligible options at the %s gate',
    (gate) => {
      const options = { round: 2, providers: [picked] };
      const form =
        gate === 'cap'
          ? buildFixLoopEscalationSchema('check', 'defect', 5, undefined, false, options)
          : buildOscillationEscalationSchema(
              'a',
              'b',
              'one',
              'two',
              undefined,
              undefined,
              undefined,
              options,
            );
      const field = form.fields.find((f) => f.id === FIX_ROUND_CLI_FIELD);
      expect(field).toMatchObject({
        type: 'select',
        default: 'same',
        visibleWhen: { field: 'fixLoopAction', equals: 'continue' },
        options: [
          { value: 'same', label: 'The same CLI' },
          { value: picked.id, label: picked.label },
        ],
      });
      expect(field?.description).toContain('next round only, this task only');
      expect(field?.description).toContain('2');
      expect(field?.description).toContain('default');
    },
  );

  it('cannot fall back when the selected provider loses a required capability', async () => {
    class NoMcpRegistry extends CliAdapterRegistry {
      override get() {
        return Object.assign(new ClaudeCodeAdapter(), { supportsMcp: false });
      }
    }
    const selection = await resolve(database(picked.id), 2);
    const plan = resolveDispatch({
      providers: selection.roundProvider ? [selection.roundProvider] : [original, picked],
      preferredProviderId: selection.cliProviderId,
      input: { kind: 'prompt', prompt: 'fix', capabilities: [] },
      invokeOpts: {},
      requiresMcp: true,
      registry: new NoMcpRegistry(),
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toMatch(/MCP/);
  });
});
