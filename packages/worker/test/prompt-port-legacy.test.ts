import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema, type Database } from '@haive/database';
import { promptStepEntrySchema } from '@haive/shared/modularity';
import {
  buildDataEdgePlan,
  parseDataEdgePlan,
  type DataEdgePlan,
} from '@haive/shared/data-edge-plan';
import type { PortNode } from '@haive/shared/step-ports';
import {
  buildPromptStep,
  type PromptStepDetect,
} from '../src/step-engine/steps/custom/prompt-step.js';
import { readRole } from '../src/step-engine/read-role.js';

// Captured by executing HEAD 556f32dc1 in a detached checkout. Hashes cover the
// exact UTF-8 prompt/JSON bytes, including key order, rather than object equality.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/prompt-port-legacy.json', import.meta.url), 'utf8'),
) as {
  prompts: {
    entry: unknown;
    detected: PromptStepDetect;
    formValues: Record<string, string>;
    integrationAccounts: Record<string, string>;
    sha256: string;
  }[];
  plans: {
    selection: DataEdgePlan['selection'];
    candidates: { executionPath: null | 'quick_bugfix'; stepIds: string[]; nodes: PortNode[] }[];
    sha256: string;
  }[];
  reads: { row: Record<string, unknown> & { taskId: string }; sha256: string }[];
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
it.each(fixture.prompts)('preserves legacy prompt bytes for $entry.slug', async (c) => {
  const entry = promptStepEntrySchema.parse(c.entry);
  const prompt = await buildPromptStep(`custom.demo.${entry.slug}`, entry, 2).llm!.buildPrompt(c);
  expect(sha(prompt)).toBe(c.sha256);
});
// Freeze the old declarations too: new admissions intentionally acquire new inputs.
// Nodes captured from b97c70f74 reproduce the original 556f32dc1 hashes unchanged.
it.each(fixture.plans)('preserves $selection v3 pin bytes', (c) => {
  const plan = buildDataEdgePlan(
    c.selection,
    c.candidates.map((candidate) => ({
      executionPath: candidate.executionPath,
      nodes: candidate.nodes,
    })),
  );
  expect(sha(JSON.stringify(plan))).toBe(c.sha256);
  expect(sha(JSON.stringify(parseDataEdgePlan(plan)))).toBe(c.sha256);
  for (const candidate of c.candidates)
    expect(candidate.nodes.map((n) => n.id)).toEqual(candidate.stepIds);
});
it.each(fixture.reads)('preserves canonical legacy role read bytes for $row.status', async (c) => {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  fake.insert(schema.tasks, { id: c.row.taskId, dataEdgePlan: null });
  fake.insert(schema.taskSteps, c.row);
  const read = await readRole(
    { db: fake.db as unknown as Database, taskId: c.row.taskId },
    'draft',
  );
  expect(sha(JSON.stringify(read))).toBe(c.sha256);
});
