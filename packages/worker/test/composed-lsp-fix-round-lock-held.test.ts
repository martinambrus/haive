import { describe, expect, it } from 'vitest';
import { schema, type DbTx } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  FixRoundCliUnavailable,
  recordFixRoundCliChoice,
} from '../src/step-engine/steps/workflow/_fix-round-cli.js';

/**
 * The next fix round's CLI choice is a writer of the composed-LSP provider rule, so it must hold
 * the task row's lock at the moment it writes: the writers that link the task to a contract-2
 * template take the same lock, and a check-then-write without it can end with both standing.
 * It is called, as in production, inside the gate's own transaction, which is what keeps a lock it
 * takes held until the write.
 */

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const CLAUDE = '00000000-0000-4000-8000-0000000000b1';
const CODEX = '00000000-0000-4000-8000-0000000000b2';

function setup() {
  const fake = createFakeDb(
    {
      tasks: schema.tasks,
      cliProviders: schema.cliProviders,
      envTemplates: schema.envTemplates,
      taskStepCliChoices: schema.taskStepCliChoices,
    },
    { rowLocks: true },
  );
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    cliProviderId: CLAUDE,
    envTemplateId: TEMPLATE,
  });
  fake.insert(schema.envTemplates, {
    id: TEMPLATE,
    userId: USER,
    name: 't',
    baseImage: 'img',
    declaredDeps: { lspInstallContractVersion: 1 },
  });
  for (const [id, name, at] of [
    [CLAUDE, 'claude-code', 1],
    [CODEX, 'codex', 2],
  ] as const)
    fake.insert(schema.cliProviders, {
      id,
      userId: USER,
      name,
      label: name,
      enabled: true,
      authMode: 'subscription',
      envVars: null,
      cliArgs: null,
      createdAt: new Date(at),
    });
  return fake;
}

describe('next fix round CLI choice write', () => {
  it('holds the task row lock when it inserts the choice (contract 1)', async () => {
    const fake = setup();
    const held: boolean[] = [];
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskStepCliChoices) held.push(fake.rowLocked(schema.tasks, TASK));
    };
    await fake.db.transaction((tx) =>
      recordFixRoundCliChoice(tx as unknown as DbTx, USER, TASK, phase2ImplementStep, 2, CODEX),
    );
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: CODEX }]);
    expect(held.length, 'a choice insert was observed').toBeGreaterThan(0);
    expect(held, 'the task row lock was held at every choice insert').not.toContain(false);
  });
});

describe('composed contract read is made after the task lock', () => {
  it('reports an unavailable choice when the provider is disabled after the initial read', async () => {
    const fake = setup();
    fake.hooks.beforeLock = () => {
      fake.patch(schema.cliProviders, CODEX, { enabled: false });
    };
    await expect(
      fake.db.transaction((tx) =>
        recordFixRoundCliChoice(tx as unknown as DbTx, USER, TASK, phase2ImplementStep, 2, CODEX),
      ),
    ).rejects.toBeInstanceOf(FixRoundCliUnavailable);
    expect(fake.rows(schema.taskStepCliChoices)).toEqual([]);
  });

  it('refuses a contract that became composed while waiting for the lock', async () => {
    const fake = setup();
    const reads: boolean[] = [];
    fake.hooks.beforeLock = () => {
      fake.patch(schema.envTemplates, TEMPLATE, { declaredDeps: { lspInstallContractVersion: 2 } });
    };
    fake.hooks.beforeRead = (table) => {
      if (table === schema.envTemplates) reads.push(fake.rowLocked(schema.tasks, TASK));
    };
    await expect(
      fake.db.transaction((tx) =>
        recordFixRoundCliChoice(tx as unknown as DbTx, USER, TASK, phase2ImplementStep, 2, CODEX),
      ),
    ).rejects.toMatchObject({ name: 'Error' });
    expect(fake.rows(schema.taskStepCliChoices)).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads).not.toContain(false);
  });
});
