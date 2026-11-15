import { SPEC_ROLES, STEP_ROLES, STEP_ROLE_REGISTRY, type StepRoleId } from './output-contracts.js';

/** Display metadata only. No schemas, policy hooks, output values or private module fields. */
export interface StepPort {
  id: string;
  role: string;
  contract: { id: string; version: number };
  authorship: 'agent' | 'human' | 'host' | 'mixed';
  optional: boolean;
  adapter?: 'effective-spec';
  /** Ordered alternatives describe the host adapter, not multiple interchangeable producers. */
  alternatives?: readonly { role: string; contract: { id: string; version: number } }[];
}
export interface StepPortProjection {
  candidates: { executionPath: string | null; graph: StepPortGraph }[];
}
export interface PortNode {
  id: string;
  label: string;
  inputs: StepPort[];
  outputs: StepPort[];
}
export type PortInputState = 'wired' | 'ambiguous' | 'dangling' | 'optional-absent';
export interface StepPortGraph {
  nodes: (Omit<PortNode, 'inputs'> & {
    inputs: (StepPort & { state: PortInputState; candidates: string[] })[];
  })[];
  edges: { source: string; sourcePort: string; target: string; targetPort: string }[];
}

/** One pure edge validator for projections and future admission. Each call is ONE candidate path.
 * A supplied binding must still identify an earlier, exactly compatible producer. */
export function validatePortEdges(
  nodes: readonly PortNode[],
  bindings: Readonly<Record<string, string>> = {},
): StepPortGraph {
  const edges: StepPortGraph['edges'] = [];
  return {
    nodes: nodes.map((node, index) => ({
      ...node,
      inputs: node.inputs.map((input) => {
        const alternatives = input.alternatives ?? [input];
        // effective-spec chooses the first present stage; that is host precedence, not ambiguity.
        const options = alternatives.map((alternative) =>
          nodes
            .slice(0, index)
            .flatMap((producer) =>
              producer.outputs
                .filter(
                  (output) =>
                    output.role === alternative.role &&
                    output.contract.id === alternative.contract.id &&
                    output.contract.version === alternative.contract.version,
                )
                .map((output) => ({ producer, output })),
            ),
        );
        const candidates = options.find((items) => items.length) ?? [];
        const key = `${node.id}:${input.id}`;
        const selected = Object.hasOwn(bindings, key)
          ? candidates.filter(({ producer }) => producer.id === bindings[key])
          : candidates;
        const state: PortInputState =
          selected.length === 1
            ? 'wired'
            : selected.length > 1
              ? 'ambiguous'
              : input.optional && !Object.hasOwn(bindings, key)
                ? 'optional-absent'
                : 'dangling';
        if (state === 'wired')
          edges.push({
            source: selected[0]!.producer.id,
            sourcePort: selected[0]!.output.id,
            target: node.id,
            targetPort: input.id,
          });
        return {
          ...input,
          state,
          candidates: [...new Set(candidates.map(({ producer }) => producer.id))],
        };
      }),
    })),
    edges,
  };
}

const port = (role: StepRoleId, id: string = role): StepPort => ({
  id,
  role,
  contract: { ...STEP_ROLE_REGISTRY[role].contract },
  authorship: STEP_ROLE_REGISTRY[role].authorship,
  optional: true,
});

/** Projection of existing core reads. Kept OUT of catalog entry/pin schemas: those remain v1/v2.
 * Spec declarations mirror composable-core; the adapter sites call _spec-artifact today.
 * This table does not declare SDK/module inputs or grant any runtime capability. */
const specInputs: Readonly<Record<string, readonly [string, StepRoleId][]>> = {
  '05-phase-0b5-spec-quality': [['draft', SPEC_ROLES.draft]],
  '05a-resolve-spec-warnings': [
    ['checked', SPEC_ROLES.checked],
    ['draft', SPEC_ROLES.draft],
  ],
  '06-gate-1-spec-approval': [
    ['resolved', SPEC_ROLES.resolved],
    ['checked', SPEC_ROLES.checked],
    ['draft', SPEC_ROLES.draft],
  ],
};
const effectiveSpecConsumers: ReadonlySet<string> = new Set([
  '06-run-config',
  '06b-sprint-planning',
  '07-phase-2-implement',
  '07a-code-simplify',
  '07b-phase-4-validate',
  '08a-browser-verify',
  '08b-test-management',
  STEP_ROLES.codeReview,
  STEP_ROLES.codeAudit,
  '08d-adversarial-qa',
  '08e-insights-triage',
  '11f-plan-reconcile',
]);
const reviewConsumers: ReadonlySet<string> = new Set([
  '09-gate-2-verify-approval',
  '10-gate-3-commit',
  '11-phase-8-learning',
]);

export interface PortProjectionOptions {
  labels?: ReadonlyMap<string, string>;
  /** Existing v2 bindings only, already decoded/evaluated by the caller. */
  roleBindings?: Readonly<
    Record<string, { stepId: string; outputContract: { id: string; version: number } }>
  >;
}
export function projectStepPorts(
  stepIds: readonly string[],
  opts: PortProjectionOptions = {},
): StepPortGraph {
  const bindings: Record<string, string> = {};
  const nodes = stepIds.map((id): PortNode => {
    const outputs: StepPort[] = [];
    for (const [roleId, registered] of Object.entries(STEP_ROLE_REGISTRY)) {
      const role = roleId as StepRoleId;
      const bound = opts.roleBindings?.[role];
      if (
        (bound?.stepId ?? registered.legacyStepId) === id &&
        (!bound ||
          (bound.outputContract.id === registered.contract.id &&
            bound.outputContract.version === registered.contract.version))
      )
        outputs.push({ ...port(role), optional: false });
    }
    const inputs = (specInputs[id] ?? []).map(([input, role]) => port(role, input));
    if (effectiveSpecConsumers.has(id))
      inputs.push({
        ...port(SPEC_ROLES.resolved, 'effective-spec'),
        adapter: 'effective-spec',
        alternatives: [SPEC_ROLES.resolved, SPEC_ROLES.checked, SPEC_ROLES.draft].map((role) => ({
          role,
          contract: { ...STEP_ROLE_REGISTRY[role].contract },
        })),
      });
    if (reviewConsumers.has(id)) inputs.push(port(STEP_ROLES.codeReview, 'review'));
    if (id === '09-gate-2-verify-approval') inputs.push(port(STEP_ROLES.codeAudit, 'audit'));
    for (const input of inputs) {
      const bound = opts.roleBindings?.[input.role];
      if (bound) bindings[`${id}:${input.id}`] = bound.stepId;
    }
    return { id, label: opts.labels?.get(id) ?? id, inputs, outputs };
  });
  return validatePortEdges(nodes, bindings);
}
