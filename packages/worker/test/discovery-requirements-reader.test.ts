import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { dataPortNodes } from '@haive/shared/step-ports';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { readRole, legacyRoleOutput } from '../src/step-engine/read-role.js';
import { loadBusinessRequirements } from '../src/step-engine/steps/workflow/_business-requirements.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
const discovery = 'haive.discovery' as const;
const draft = 'haive.requirements.draft' as const;
const humanized = 'haive.requirements.humanized' as const;
const ids = [
  '03-phase-0a-discovery',
  '03b-business-requirements',
  '03b2-humanize-requirements',
  '03c-business-requirements-review',
  '04-phase-0b-pre-planning',
];
function fixture() {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  const taskId = randomUUID(),
    taskStepId = randomUUID();
  fake.insert(schema.tasks, { id: taskId });
  fake.insert(schema.taskSteps, { id: taskStepId, taskId, stepId: ids[3], round: 1 });
  const ctx = {
    db: fake.db,
    taskId,
    taskStepId,
    round: 1,
    logger: { warn: vi.fn() },
  } as unknown as StepContext;
  const put = (stepId: string, output: unknown, round = 0, status = 'done') =>
    fake.insert(schema.taskSteps, {
      id: randomUUID(),
      taskId,
      stepId,
      output,
      round,
      status,
      iterations: [],
    });
  return { ctx, fake, put, taskId };
}
it('reads discovery absent, host stub and agent aggregate without exposing extensions', async () => {
  const { ctx, put } = fixture();
  expect(await readRole(ctx, discovery)).toMatchObject({ state: 'absent' });
  for (const [round, source] of ['stub', 'agents'].entries()) {
    put(
      ids[0]!,
      { summary: source, relevantKbIds: ['KB'], source, agentMinings: [{ private: true }] },
      round,
    );
    expect(await readRole(ctx, discovery)).toMatchObject({
      state: 'ready',
      data: { summary: source, relevantKbIds: ['KB'], source },
    });
    expect(legacyRoleOutput(await readRole(ctx, discovery))).not.toHaveProperty('agentMinings');
  }
});
it.each([
  [null, null, { requirements: '', summary: '' }],
  [{ requirements: 'raw', summary: 'R' }, null, { requirements: 'raw', summary: 'R' }],
  [
    { requirements: 'raw', summary: 'R' },
    { requirements: ' human ', summary: 'H' },
    { requirements: ' human ', summary: 'H' },
  ],
  [
    { requirements: 'raw', summary: 'R' },
    { requirements: ' \n', summary: 'H' },
    { requirements: 'raw', summary: 'R' },
  ],
  [
    { requirements: '', summary: 'empty raw' },
    { requirements: '', summary: 'H' },
    { requirements: '', summary: 'empty raw' },
  ],
  [{ summary: 'old raw' }, { requirements: null }, { requirements: '', summary: 'old raw' }],
])('preserves effective requirements fallback %j / %j', async (raw, polished, expected) => {
  const { ctx, put } = fixture();
  if (raw) put(ids[1]!, raw);
  if (polished) put(ids[2]!, polished);
  expect(await loadBusinessRequirements(ctx)).toEqual(expected);
});
it('Retry clears newest 03b2 then 03b without resurrecting old success; explicit ceilings work', async () => {
  const { ctx, put } = fixture();
  put(ids[1]!, { requirements: 'raw', summary: 'R' });
  put(ids[2]!, { requirements: 'human', summary: 'H' });
  put(ids[2]!, null, 2, 'pending');
  expect(await loadBusinessRequirements(ctx)).toEqual({ requirements: 'raw', summary: 'R' });
  put(ids[1]!, null, 2, 'pending');
  expect(await loadBusinessRequirements(ctx)).toEqual({ requirements: '', summary: '' });
  expect(legacyRoleOutput(await readRole(ctx, humanized, 0))).toEqual({
    requirements: 'human',
    summary: 'H',
  });
  expect(legacyRoleOutput(await readRole(ctx, draft, 0))).toEqual({
    requirements: 'raw',
    summary: 'R',
  });
});
it.each(['missing-inputs', 'missing-consumer', 'no-v3'])(
  'old %s keeps canonical unbounded retained-output reads',
  async (mode) => {
    const { ctx, fake, put, taskId } = fixture();
    const nodes = dataPortNodes(ids).map((n) => ({ ...n, inputs: [] }));
    const pin =
      mode === 'no-v3'
        ? null
        : buildDataEdgePlan('static', [
            { executionPath: null, nodes: mode === 'missing-consumer' ? nodes.slice(0, 3) : nodes },
          ]);
    fake.patch(schema.tasks, taskId, { dataEdgePlan: pin });
    put(ids[2]!, { requirements: 'future retained', summary: 'H' }, 3, 'pending');
    expect(await loadBusinessRequirements(ctx)).toEqual({
      requirements: 'future retained',
      summary: 'H',
    });
    expect(await readRole(ctx, humanized)).toMatchObject({
      state: 'not-ready',
      producer: { round: 3 },
    });
  },
);
it('new v3 pins exact alternate producers with round ceilings and suppresses reset output', async () => {
  const { ctx, fake, put, taskId } = fixture();
  const nodes = dataPortNodes(ids);
  nodes[1]!.id = 'module.example.raw';
  nodes[2]!.id = 'module.example.polished';
  const pin = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  fake.patch(schema.tasks, taskId, { dataEdgePlan: pin });
  put(ids[2]!, { requirements: 'canonical decoy', summary: '' });
  put(nodes[1]!.id, { requirements: 'pinned raw', summary: 'R' });
  put(nodes[2]!.id, { requirements: 'pinned human', summary: 'H' });
  put(nodes[2]!.id, { requirements: 'future', summary: 'F' }, 2);
  expect(await loadBusinessRequirements(ctx)).toEqual({
    requirements: 'pinned human',
    summary: 'H',
  });
  put(nodes[2]!.id, { requirements: 'stale reset', summary: 'S' }, 1, 'pending');
  expect(await loadBusinessRequirements(ctx)).toEqual({ requirements: 'pinned raw', summary: 'R' });
  put(nodes[1]!.id, null, 1, 'pending');
  expect(await loadBusinessRequirements(ctx)).toEqual({ requirements: '', summary: '' });
  expect(fake.rows(schema.tasks)[0]!.dataEdgePlan).toEqual(pin);
});
it('all reader inputs are declared optional and all producers declare exact data roles', () => {
  for (const [index, role] of [discovery, draft, humanized].entries()) {
    expect(CORE_COMPOSABLE_STEPS.find((e) => e.stepId === ids[index])!.providesRoles).toEqual([
      { role, contract: { id: role, version: 1 } },
    ]);
  }
  for (const index of [1, 2, 3, 4]) {
    const inputs = CORE_COMPOSABLE_STEPS.find((e) => e.stepId === ids[index])!.consumesRoles;
    expect(inputs?.length).toBe(index > 2 ? (index === 4 ? 3 : 2) : 1);
    expect(inputs?.every((i) => i.optional)).toBe(true);
  }
});

it.each(['absent', 'unselected', 'malformed', 'missing-binding', 'wrong-contract'])(
  'v3 %s never borrows canonical requirements',
  async (mode) => {
    const { ctx, fake, put, taskId } = fixture();
    put(ids[2]!, { requirements: 'canonical decoy', summary: 'H' });
    const nodes = dataPortNodes(mode === 'absent' ? [ids[3]!] : ids);
    const pin = buildDataEdgePlan(mode === 'unselected' ? 'derived' : 'static', [
      { executionPath: null, nodes },
    ]);
    if (mode === 'missing-binding') delete pin.candidates[0]!.bindings['3:requirements-humanized'];
    if (mode === 'wrong-contract') pin.candidates[0]!.nodes[3]!.inputs[0]!.contract.version = 2;
    fake.patch(schema.tasks, taskId, { dataEdgePlan: mode === 'malformed' ? { version: 3 } : pin });
    if (['malformed', 'missing-binding', 'wrong-contract'].includes(mode))
      await expect(loadBusinessRequirements(ctx)).rejects.toThrow('invalid-data-edge-plan');
    else expect(await loadBusinessRequirements(ctx)).toEqual({ requirements: '', summary: '' });
  },
);
