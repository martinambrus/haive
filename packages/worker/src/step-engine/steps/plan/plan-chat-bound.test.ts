import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { planChatStep } from './01-plan-chat.js';
import { PLAN_EXPANSION_CONTEXT_MAX_CHARS } from './_plan-expansion-context.js';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function turn(count: number, bodySize: number, messages: { role: string; body: string }[]) {
  const root = id(1);
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    repositoryId: id(990),
    parentId: i ? root : null,
    path: i ? `/${root}/${id(i + 1)}/` : `/${root}/`,
    ordinal: i,
    title: `Component ${i}`,
    body: 'body '.repeat(bodySize),
    kind: 'component',
    status: 'todo',
    taskable: false,
    version: i + 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const fake = createFakeDb({
    tasks: schema.tasks,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeMessages: schema.planNodeMessages,
  });
  fake.insert(schema.tasks, {
    id: id(991),
    userId: id(992),
    repositoryId: id(990),
    metadata: { planNodeId: root },
  });
  for (const node of nodes) fake.insert(schema.planNodes, node);
  messages.forEach((m, i) =>
    fake.insert(schema.planNodeMessages, {
      ...m,
      id: id(1000 + i),
      nodeId: root,
      taskId: id(991),
      createdAt: new Date(i),
    }),
  );
  const detected = await planChatStep.detect!({
    db: fake.db,
    taskId: id(991),
    userId: id(992),
  } as never);
  return {
    detected,
    prompt: planChatStep.llm!.skipIf!({ detected, formValues: {} })
      ? ''
      : planChatStep.llm!.buildPrompt({ detected, formValues: {} }),
  };
}

describe('plan chat whole context', () => {
  it('refuses an impossible mandatory budget without cutting the pending turn', () => {
    expect(() =>
      planChatStep.llm!.promptBudget!.buildPrompt(
        {
          detected: {
            nodeTitle: 'Focus',
            nodeId: 'focus',
            nodeVersion: 1,
            transcript: [],
            pendingQuestion: 'whole user turn',
            planMarkdown: '',
          },
          formValues: {},
        },
        10,
      ),
    ).toThrow();
  });
  it('bounds an 800-node plan while retaining the pending turn whole', async () => {
    const pending = 'PENDING-' + 'x'.repeat(19_992);
    const { prompt } = await turn(800, 40, [{ role: 'user', body: pending }]);
    expect(prompt.length).toBeLessThanOrEqual(PLAN_EXPANSION_CONTEXT_MAX_CHARS);
    expect(prompt).toContain(pending);
    expect(prompt).toContain('/haive/plan-chat-snapshot.json');
  });
  it('drops whole long child bodies and states the cut', async () => {
    const { prompt } = await turn(4, 9_000, [{ role: 'user', body: 'Please adjust it' }]);
    expect(prompt.length).toBeLessThanOrEqual(PLAN_EXPANSION_CONTEXT_MAX_CHARS);
    expect(prompt).toMatch(/neighbourhood.*omitted/i);
  });
  it('reserves the pending turn before packing chronological earlier turns', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      body: `TURN-${i}-` + 'x'.repeat(1400),
    }));
    messages.push({ role: 'user', body: 'pending '.repeat(2500) });
    const { prompt } = await turn(1, 0, messages);
    expect(prompt.length).toBeLessThanOrEqual(PLAN_EXPANSION_CONTEXT_MAX_CHARS);
    expect(prompt).toContain(messages.at(-1)!.body);
    expect(prompt).not.toContain('TURN-0-');
    expect(prompt.indexOf('TURN-28-')).toBeLessThan(prompt.indexOf('TURN-29-'));
  });
  it('parks an existing oversized pending turn for an explicit edit', async () => {
    const { detected } = await turn(1, 0, [{ role: 'user', body: 'x'.repeat(20_001) }]);
    const form = planChatStep.form!({} as never, detected);
    expect(form).not.toBeNull();
    expect(form?.description).toMatch(/20,000|20000/);
    expect(form?.fields[0]).toMatchObject({ id: 'message', default: 'x'.repeat(20_001) });
    expect(planChatStep.llm!.skipIf!({ detected, formValues: {} })).toBe(true);
  });
});
