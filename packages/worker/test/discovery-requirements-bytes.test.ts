// SHA-256 fixtures captured on b97c70f74 before replacing physical reads. Hashes cover
// complete JSON values/forms and complete prompt bytes, not selected substrings.
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { dataPortNodes } from '@haive/shared/step-ports';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
import { businessRequirementsStep } from '../src/step-engine/steps/workflow/03b-business-requirements.js';
import { humanizeRequirementsStep } from '../src/step-engine/steps/workflow/03b2-humanize-requirements.js';
import { businessRequirementsReviewStep } from '../src/step-engine/steps/workflow/03c-business-requirements-review.js';
import { phase0bPrePlanningStep } from '../src/step-engine/steps/workflow/04-phase-0b-pre-planning.js';
import { rolePin } from './step-role-fixtures.js';
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: async () => ({ enabled: [] }),
  dimensionScopeLines: () => [],
}));
vi.mock('../src/step-engine/steps/workflow/_biz-req-feedback.js', () => ({
  loadOutstandingBizReqFeedback: async () => 'Please clarify eligibility.',
}));
vi.mock('../src/step-engine/steps/workflow/_spec-feedback.js', () => ({
  loadOutstandingSpecFeedback: async () => 'Preserve compatibility.',
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  readTextNoFollow: async () => '# Knowledge\n\nExisting rules.',
}));
const cases = [
  { name: 'absent', discovery: null, draft: null, humanized: null },
  {
    name: 'discovery stub',
    discovery: {
      summary: 'Task: Operator words\n\nKB topics',
      relevantKbIds: ['KB'],
      source: 'stub',
    },
    draft: null,
    humanized: null,
  },
  {
    name: 'real discovery and draft',
    discovery: { summary: '## Agent\n\nFindings.', relevantKbIds: ['KB'], source: 'agents' },
    draft: { requirements: '# Draft\n\nRaw.', summary: 'Raw' },
    humanized: null,
  },
  {
    name: 'humanized',
    discovery: { summary: 'Findings', relevantKbIds: [] },
    draft: { requirements: 'Raw', summary: 'R' },
    humanized: { requirements: '# Requirements\n\nPolished.', summary: 'H' },
  },
  {
    name: 'blank humanized',
    discovery: { summary: '', relevantKbIds: [] },
    draft: { requirements: 'Raw', summary: 'R' },
    humanized: { requirements: ' \n', summary: 'H' },
  },
  {
    name: 'empty draft',
    discovery: {},
    draft: { requirements: '', summary: 'empty' },
    humanized: { requirements: '', summary: 'H' },
  },
  {
    name: 'historical partial',
    discovery: { summary: 'old', relevantKbIds: null },
    draft: { summary: 'old draft' },
    humanized: { summary: 'old human' },
  },
];
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
it.each(['builtin', 'derived-v1', 'derived-v2'])(
  '%s values, forms and prompts stay byte-identical to base',
  async (kind) => {
    const captures = [];
    for (const c of cases) {
      const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
      const taskId = randomUUID();
      fake.insert(schema.tasks, {
        id: taskId,
        title: 'Add eligibility',
        description: 'Stakeholders need clear eligibility rules.',
        repositoryId: null,
        ...(kind === 'builtin' ? {} : rolePin(kind === 'derived-v1' ? 1 : 2)),
      });
      const inputs = [c.discovery, c.draft, c.humanized];
      const producerIds = [
        '03-phase-0a-discovery',
        '03b-business-requirements',
        '03b2-humanize-requirements',
      ];
      inputs.forEach((output, i) => {
        if (output)
          fake.insert(schema.taskSteps, {
            id: randomUUID(),
            taskId,
            stepId: producerIds[i],
            round: 0,
            status: 'done',
            output,
            iterations: [],
          });
      });
      const ctx = {
        db: fake.db,
        taskId,
        repoPath: '/unused',
        sandboxWorkdir: '/workspace',
        logger: { warn: vi.fn() },
      } as unknown as StepContext;
      for (const step of [
        businessRequirementsStep,
        humanizeRequirementsStep,
        businessRequirementsReviewStep,
        phase0bPrePlanningStep,
      ] as StepDefinition[]) {
        const detected = await step.detect!(ctx);
        const form = await step.form!(ctx, detected);
        const args = {
          detected,
          formValues: { guidance: 'Preserve criteria', scope: 'Keep scope small' },
          ctx,
          iteration: 0,
          previousIterations: [],
        };
        const prompt = step.llm?.buildPrompt(args as never);
        captures.push({
          case: c.name,
          step: step.metadata.id,
          detected: hash(detected),
          form: hash(form),
          prompt: prompt == null ? null : hash(prompt),
          shouldRun: step.shouldRun ? await step.shouldRun(ctx) : true,
        });
        // The same base fixture also governs new independently pinned stage inputs.
        const row = fake.rows(schema.taskSteps).find((r) => r.stepId === step.metadata.id);
        const taskStepId = typeof row?.id === 'string' ? row.id : randomUUID();
        if (!row)
          fake.insert(schema.taskSteps, {
            id: taskStepId,
            taskId,
            stepId: step.metadata.id,
            round: 0,
            status: 'running',
            output: null,
            iterations: [],
          });
        const pinnedCtx = { ...ctx, taskStepId, round: 0 };
        const derived = kind !== 'builtin';
        const nodes = dataPortNodes([
          ...producerIds,
          '03c-business-requirements-review',
          '04-phase-0b-pre-planning',
        ]);
        const legacySnapshot = fake.rows(schema.tasks)[0]!.runListSnapshot;
        fake.patch(schema.tasks, taskId, {
          runListSnapshot: nodes.map((n) => n.id),
          dataEdgePlan: buildDataEdgePlan(derived ? 'derived' : 'static', [
            { executionPath: null, nodes },
            ...(derived ? [{ executionPath: 'full_workflow' as const, nodes }] : []),
          ]),
        });
        const pinnedDetected = await step.detect!(pinnedCtx);
        const pinnedPrompt = step.llm?.buildPrompt({
          ...args,
          detected: pinnedDetected,
          ctx: pinnedCtx,
        } as never);
        expect({
          detected: hash(pinnedDetected),
          form: hash(await step.form!(pinnedCtx, pinnedDetected)),
          prompt: pinnedPrompt == null ? null : hash(pinnedPrompt),
          shouldRun: step.shouldRun ? await step.shouldRun(pinnedCtx) : true,
        }).toEqual({
          detected: hash(detected),
          form: hash(form),
          prompt: prompt == null ? null : hash(prompt),
          shouldRun: captures.at(-1)!.shouldRun,
        });
        fake.patch(schema.tasks, taskId, { dataEdgePlan: null, runListSnapshot: legacySnapshot });
      }
    }
    expect(captures).toMatchSnapshot();
  },
);
