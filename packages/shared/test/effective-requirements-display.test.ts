import { afterEach, expect, it, vi } from 'vitest';
import {
  DISCOVERY_ROLE,
  REQUIREMENTS_ROLES,
  STEP_ROLE_REGISTRY,
} from '../src/step-engine/output-contracts.js';
import type { DataInput } from '../src/step-engine/core-data-ports.js';

const input = (name: string, role: DataInput['role']): DataInput => ({
  input: name,
  role,
  contract: STEP_ROLE_REGISTRY[role].contract,
  optional: true,
});

afterEach(() => {
  vi.doUnmock('../src/step-engine/core-data-ports.js');
  vi.resetModules();
});

it.each([
  ['requirements-humanized', 'requirements-draft'],
  ['polished-document', 'raw-document'],
])('groups effective requirements by roles with input names %s / %s', async (humanized, draft) => {
  vi.doMock('../src/step-engine/core-data-ports.js', async (original) => ({
    ...(await original<typeof import('../src/step-engine/core-data-ports.js')>()),
    DISCOVERY_REQUIREMENTS_INPUTS: {
      'renamed.consumer': [
        input('requirements-context', DISCOVERY_ROLE),
        input(humanized, REQUIREMENTS_ROLES.humanized),
        input(draft, REQUIREMENTS_ROLES.draft),
      ],
      'renamed.humanizer': [input(draft, REQUIREMENTS_ROLES.draft)],
    },
  }));
  const { projectStepPorts } = await import('../src/step-engine/step-ports.js');
  const graph = projectStepPorts([
    STEP_ROLE_REGISTRY[DISCOVERY_ROLE].legacyStepId,
    STEP_ROLE_REGISTRY[REQUIREMENTS_ROLES.draft].legacyStepId,
    STEP_ROLE_REGISTRY[REQUIREMENTS_ROLES.humanized].legacyStepId,
    'renamed.consumer',
    'renamed.humanizer',
  ]);
  expect(graph.nodes[3]!.inputs.map((i) => i.id)).toEqual([
    'requirements-context',
    'effective-requirements',
  ]);
  expect(graph.nodes[3]!.inputs[1]).toMatchObject({
    adapter: 'effective-requirements',
    state: 'wired',
    alternatives: [{ role: REQUIREMENTS_ROLES.humanized }, { role: REQUIREMENTS_ROLES.draft }],
  });
  expect(graph.nodes[4]!.inputs).toEqual([
    expect.objectContaining({ id: draft, role: REQUIREMENTS_ROLES.draft, state: 'wired' }),
  ]);
});
