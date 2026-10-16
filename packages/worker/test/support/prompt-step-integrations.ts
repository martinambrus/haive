import { parsePinnedCustomSteps } from '@haive/shared/modularity';
import type { StepDefinition } from '../../src/step-engine/step-definition.js';
import { buildPromptStep } from '../../src/step-engine/steps/custom/prompt-step.js';

// Fixtures of the J6a controls (task #185): a prompt step a task pinned, with what it declares.

export const TYPE_SLUG = 'demo';
export const STEP_ID = `custom.${TYPE_SLUG}.audit`;

export interface DeclaredRequirement {
  id: string;
  category?: string;
  provider?: string;
  access: 'read' | 'write';
  optional?: boolean;
}

export const FORGE_READ: DeclaredRequirement = { id: 'forge', category: 'forge', access: 'read' };
export const FORGE_WRITE: DeclaredRequirement = { id: 'forge', category: 'forge', access: 'write' };
export const TRACKER_OPTIONAL: DeclaredRequirement = {
  id: 'tracker',
  category: 'issues',
  access: 'read',
  optional: true,
};

/** Requirements that fail the requirement schema, with the id the failure must name. */
export const BAD_REQUIREMENTS: [string, unknown, string][] = [
  ['neither a category nor a provider', { id: 'broken', access: 'read' }, 'broken'],
  [
    'both a category and a provider',
    { id: 'broken', category: 'forge', provider: 'github', access: 'read' },
    'broken',
  ],
  [
    'an access that is neither read nor write',
    { id: 'broken', category: 'forge', access: 'admin' },
    'broken',
  ],
];

/** The prompt step as the task type stores it, and as a task copies it into custom_steps. */
export function storedPromptStep(
  integrations: unknown[] | undefined,
  over: { id?: string; slug?: string } = {},
): Record<string, unknown> {
  const slug = over.slug ?? 'audit';
  return {
    [over.id ?? STEP_ID]: {
      slug,
      title: 'Audit',
      template: 'Audit {{task.title}}',
      capabilities: [],
      timeoutMs: 300_000,
      tools: [],
      ...(integrations === undefined ? {} : { integrations }),
    },
  };
}

/** The step a task runs for it: read back from the pinned copy the way the worker reads it, then built. */
export function pinnedPromptStep(
  integrations: unknown[] | undefined,
  over: { id?: string; slug?: string } = {},
): { stepDef: StepDefinition; stored: Record<string, unknown> } {
  const id = over.id ?? STEP_ID;
  const stored = storedPromptStep(integrations, over);
  const entry = parsePinnedCustomSteps(stored)[id];
  if (!entry) throw new Error(`the fixture ${id} does not read back as a pinned prompt step`);
  return { stepDef: buildPromptStep(id, entry, 0) as unknown as StepDefinition, stored };
}
