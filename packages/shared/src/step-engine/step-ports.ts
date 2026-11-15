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
  /** An unselected task shows candidate metadata, never pinned bindings. */
  candidatesOnly?: boolean;
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
  edges: {
    source: string;
    sourceIndex: number;
    sourcePort: string;
    target: string;
    targetIndex: number;
    targetPort: string;
  }[];
}

/** One pure edge validator for projections and future admission. Each call is ONE candidate path.
 * A supplied binding must still identify an earlier, exactly compatible producer. */
export function validatePortEdges(
  nodes: readonly PortNode[],
  bindings: Readonly<Record<string, number>> = {},
): StepPortGraph {
  const edges: StepPortGraph['edges'] = [];
  type Producer = { producer: PortNode; index: number; output: StepPort };
  const producers = new Map<
    string,
    { all: Producer[]; byIndex: Map<number, Producer[]>; ids: Set<string> }
  >();
  const contractKey = (port: { role: string; contract: { id: string; version: number } }) =>
    JSON.stringify([port.role, port.contract.id, port.contract.version]);
  // Walk once in run order: the index contains only earlier producers. Work is linear
  // in ports plus the candidate ids returned (an ambiguous result may itself be large).
  const projected = nodes.map((node, index) => {
    const inputs = node.inputs.map((input) => {
      const alternatives = input.alternatives ?? [input];
      const bucket = alternatives
        .map((alternative) => producers.get(contractKey(alternative)))
        .find((bucket) => bucket?.all.length);
      const candidates = bucket?.all ?? [];
      const key = `${index}:${input.id}`;
      const bound = Object.hasOwn(bindings, key);
      const selected = bound ? (bucket?.byIndex.get(bindings[key]!) ?? []) : candidates;
      const state: PortInputState =
        selected.length === 1
          ? 'wired'
          : selected.length > 1
            ? 'ambiguous'
            : input.optional && !bound
              ? 'optional-absent'
              : 'dangling';
      if (state === 'wired')
        edges.push({
          source: selected[0]!.producer.id,
          sourceIndex: selected[0]!.index,
          sourcePort: selected[0]!.output.id,
          target: node.id,
          targetIndex: index,
          targetPort: input.id,
        });
      return {
        ...input,
        state,
        candidates: [...(bucket?.ids ?? [])],
      };
    });
    for (const output of node.outputs) {
      const key = contractKey(output);
      let bucket = producers.get(key);
      if (!bucket) {
        bucket = { all: [], byIndex: new Map(), ids: new Set() };
        producers.set(key, bucket);
      }
      const item = { producer: node, index, output };
      bucket.all.push(item);
      bucket.ids.add(node.id);
      const matches = bucket.byIndex.get(index) ?? [];
      matches.push(item);
      bucket.byIndex.set(index, matches);
    }
    return { ...node, inputs };
  });
  return { nodes: projected, edges };
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
  const bindings: Record<string, number> = {};
  const positions = new Map<string, number>();
  stepIds.forEach((id, index) => {
    if (!positions.has(id)) positions.set(id, index);
  });
  const nodes = stepIds.map((id, index): PortNode => {
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
      if (bound) bindings[`${index}:${input.id}`] = positions.get(bound.stepId) ?? -1;
    }
    return { id, label: opts.labels?.get(id) ?? id, inputs, outputs };
  });
  return validatePortEdges(nodes, bindings);
}
