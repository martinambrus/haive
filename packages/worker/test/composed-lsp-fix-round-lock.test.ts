import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  FixRoundCliLocked,
  FixRoundCliUnavailable,
  fixRoundCliRole,
  fixRoundRefusalBody,
  recordFixRoundCliChoice,
} from '../src/step-engine/steps/workflow/_fix-round-cli.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const CLAUDE = '00000000-0000-4000-8000-0000000000b1';
const CODEX = '00000000-0000-4000-8000-0000000000b2';

function setup(contract: number) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
    envTemplates: schema.envTemplates,
    taskStepCliChoices: schema.taskStepCliChoices,
  });
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
    declaredDeps: { lspInstallContractVersion: contract },
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
const record = (fake: ReturnType<typeof setup>, providerId: string) =>
  recordFixRoundCliChoice(
    fake.db as unknown as Database,
    USER,
    TASK,
    phase2ImplementStep,
    2,
    providerId,
  );

describe('next fix round CLI on a composed-LSP task', () => {
  it('rejects codex under contract 2 and inserts nothing', async () => {
    const fake = setup(2);
    await expect(record(fake, CODEX)).rejects.toBeInstanceOf(FixRoundCliUnavailable);
    expect(fake.rows(schema.taskStepCliChoices)).toEqual([]);
  });

  it('names the lock, not a missing provider, in the refusal the gate shows', async () => {
    const fake = setup(2);
    const refusal = await record(fake, CODEX).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(FixRoundCliLocked);
    expect(refusal).toBeInstanceOf(FixRoundCliUnavailable);
    expect(fixRoundRefusalBody(refusal as FixRoundCliUnavailable)).toBe(
      (refusal as FixRoundCliUnavailable).message,
    );
    expect(fixRoundRefusalBody(refusal as FixRoundCliUnavailable)).toMatch(/composed image/);
  });

  it('keeps the generic copy for any other refusal (legacy parity pin)', () => {
    expect(fixRoundRefusalBody(new FixRoundCliUnavailable('The CLI went away.'))).toBe(
      'The selected CLI is no longer available for the next fix round. Choose another CLI or keep the same CLI, then submit again.',
    );
  });

  it('records the verified provider under contract 2', async () => {
    const fake = setup(2);
    await record(fake, CLAUDE);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([
      { taskId: TASK, role: fixRoundCliRole(2), cliProviderId: CLAUDE },
    ]);
  });

  it('records codex under contract 1', async () => {
    const fake = setup(1);
    await record(fake, CODEX);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: CODEX }]);
  });
});
