import { expect, it } from 'vitest';
import {
  promptStepEntrySchema,
  validatePromptStep,
  derivePromptStepComposable,
  checkPromptSteps,
  renderPromptTemplate,
} from '../src/modularity/index.js';
import { STEP_ROLES, SPEC_ROLES, STEP_ROLE_REGISTRY } from '../src/step-engine/output-contracts.js';
import { dataPortNodes } from '../src/step-engine/core-data-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';

const role = STEP_ROLES.codeAudit;
const contract = STEP_ROLE_REGISTRY[role].contract;
const base = {
  slug: 'use',
  title: 'Use',
  template: '{{role:report}}',
  timeoutMs: 60000,
  capabilities: [],
  tools: [],
};
const input = { input: 'report', role, contract, optional: false };
const context = { typeSlug: 'demo', requiresRepository: false, stepIdsBefore: [] };
const entry = (patch = {}) =>
  promptStepEntrySchema.parse({ ...base, consumesRoles: [input], ...patch });

it('retains prompt declarations and exposes the same edge to the canvas and v3 writer', () => {
  const e = entry();
  expect(e).toHaveProperty('consumesRoles', [input]);
  expect(validatePromptStep(e, context)).toEqual([]);
  const c = derivePromptStepComposable(e, 'demo', false);
  const nodes = dataPortNodes([role, c.stepId], {}, new Map([[c.stepId, c]]));
  const pin = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  expect(pin.candidates[0]!.bindings['1:report']?.producerStepId).toBe(role);
});

it.each(['prefix {{role:report}}', '{{{role:report}}}', '{{role:{{role:report}}}}'])(
  'refuses inline or nested role tokens: %s',
  (template) => {
    expect(validatePromptStep(entry({ template }), context).map((p) => p.kind)).toContain(
      'role-token-not-own-line',
    );
  },
);
it('refuses undeclared inputs and human/mixed roles in shared save/admission checks', () => {
  expect(validatePromptStep(entry({ consumesRoles: [] }), context).map((p) => p.kind)).toContain(
    'role-not-declared',
  );
  for (const role of Object.values(SPEC_ROLES)) {
    const e = entry({
      consumesRoles: [{ ...input, role, contract: STEP_ROLE_REGISTRY[role].contract }],
    });
    expect(
      checkPromptSteps(
        { slug: 'demo', requiresRepository: false, stepIds: ['custom.demo.use'] },
        { use: e },
        { composable: new Map() },
      ).map((p) => p.kind),
    ).toContain('role-token-not-quotable');
  }
});
it('requires structured mode for providing one exact host contract', () => {
  const providesRoles = [{ role, contract }];
  expect(
    validatePromptStep(entry({ template: 'Produce', providesRoles }), context).map((p) => p.kind),
  ).toContain('role-output-mode-required');
  const structured = entry({ template: 'Produce', outputMode: 'structured', providesRoles });
  expect(structured).toHaveProperty('outputMode', 'structured');
  expect(validatePromptStep(structured, context)).toEqual([]);
  expect(
    promptStepEntrySchema.safeParse({
      ...structured,
      providesRoles: [{ role, contract: { ...contract, version: 2 } }],
    }).success,
  ).toBe(false);
});
it('keeps substituted tokens literal in the single-pass renderer', () => {
  expect(
    renderPromptTemplate('{{task.description}}', {
      fields: {},
      steps: {},
      integrations: {},
      taskTitle: '',
      taskDescription: '{{role:report}}',
    }),
  ).toBe('{{role:report}}');
});
