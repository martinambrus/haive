export * from './core-data-ports.js';
import {
  CORE_DATA_INPUTS,
  SPEC_INPUTS,
  dataPortNodes,
  type DataRoleBindings,
} from './core-data-ports.js';
import type { DataRoleBindingsDraft, RolePortDeclarations } from './role-port-declarations.js';
export type { DataRoleBindingsDraft } from './role-port-declarations.js';
import { SPEC_ROLES, STEP_ROLES, STEP_ROLE_REGISTRY, type StepRoleId } from './output-contracts.js';

export const MAX_DATA_PORT_STEPS = 256;

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
  bindings: Readonly<Record<string, number | null>> = {},
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
      const selected = bound ? (bucket?.byIndex.get(bindings[key] ?? -1) ?? []) : candidates;
      const state: PortInputState =
        bound && bindings[key] === null
          ? input.optional
            ? 'optional-absent'
            : 'dangling'
          : selected.length === 1
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

/** Legacy display adapters derive their consumers from the same core input inventory.
 * Editable drafts show individual inputs; no display metadata grants host policy. */
const effectiveSpecConsumers = new Set(
  Object.entries(SPEC_INPUTS)
    .filter(([id, inputs]) => id !== '06-gate-1-spec-approval' && inputs.length === 3)
    .map(([id]) => id),
);
const reviewConsumers = new Set(
  Object.entries(CORE_DATA_INPUTS)
    .filter(([, inputs]) => inputs.some((i) => i.input === 'review'))
    .map(([id]) => id),
);

export interface PortProjectionOptions {
  labels?: ReadonlyMap<string, string>;
  declarations?: ReadonlyMap<string, RolePortDeclarations>;
  dataRoleBindings?: DataRoleBindingsDraft;
  executionPath?: string | null;
  /** Existing v2 bindings only, already decoded/evaluated by the caller. */
  roleBindings?: Readonly<
    Record<string, { stepId: string; outputContract: { id: string; version: number } }>
  >;
}
export function projectStepPorts(
  stepIds: readonly string[],
  opts: PortProjectionOptions = {},
): StepPortGraph {
  if (opts.declarations || opts.dataRoleBindings) {
    const nodes = dataPortNodes(stepIds, opts.roleBindings, opts.declarations).map((n) => ({
      ...n,
      label: opts.labels?.get(n.id) ?? n.label,
    }));
    return validatePortEdges(
      nodes,
      portBindingIndexes(nodes, opts.dataRoleBindings ?? [], opts.executionPath ?? null),
    );
  }
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
    const inputs = effectiveSpecConsumers.has(id)
      ? []
      : (SPEC_INPUTS[id] ?? []).map((d) => ({ ...port(d.role, d.input), optional: d.optional }));
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

export function bindPortInput(
  bindings: DataRoleBindingsDraft,
  executionPath: string | null,
  consumerStepId: string,
  input: string,
  producerStepId: string,
): DataRoleBindingsDraft {
  const remaining = bindings.filter(
    (b) =>
      !(
        b.executionPath === executionPath &&
        b.consumerStepId === consumerStepId &&
        b.input === input
      ),
  );
  return producerStepId
    ? [...remaining, { executionPath, consumerStepId, input, producerStepId }]
    : remaining;
}
export function portBindingIndexes(
  nodes: readonly PortNode[],
  bindings: DataRoleBindingsDraft,
  executionPath: string | null,
): Record<string, number> {
  const indexes: Record<string, number> = {};
  for (const b of bindings.filter((b) => b.executionPath === executionPath)) {
    const index = nodes.findIndex((n) => n.id === b.consumerStepId);
    if (index < 0 || !nodes[index]!.inputs.some((i) => i.id === b.input))
      throw new Error(`invalid-data-role-binding: ${b.consumerStepId}.${b.input}`);
    indexes[`${index}:${b.input}`] = nodes.findIndex((n) => n.id === b.producerStepId);
  }
  return indexes;
}

/** Save and editor validation share the same graph; no fingerprint/plan is built for a preview. */
export function dataRoleDraftIssues(
  candidates: readonly {
    executionPath: string | null;
    stepIds: readonly string[];
    roleBindings?: DataRoleBindings;
  }[],
  entries: ReadonlyMap<string, RolePortDeclarations>,
  bindings: DataRoleBindingsDraft = [],
  maxSteps = MAX_DATA_PORT_STEPS,
): { kind: 'invalid-data-role-binding'; stepId: string; input: string; message: string }[] {
  const issues: ReturnType<typeof dataRoleDraftIssues> = [];
  const paths = new Set(candidates.map((c) => c.executionPath));
  for (const b of bindings)
    if (!paths.has(b.executionPath))
      issues.push({
        kind: 'invalid-data-role-binding',
        stepId: b.consumerStepId,
        input: b.input,
        message: 'unknown candidate path',
      });
  for (const c of candidates) {
    if (c.stepIds.length > maxSteps) {
      issues.push({
        kind: 'invalid-data-role-binding',
        stepId: '',
        input: '',
        message: 'step-count exceeds admission limit',
      });
      continue;
    }
    try {
      const nodes = dataPortNodes(c.stepIds, c.roleBindings, entries);
      const graph = validatePortEdges(nodes, portBindingIndexes(nodes, bindings, c.executionPath));
      for (const n of graph.nodes)
        for (const i of n.inputs)
          if (i.state === 'ambiguous' || i.state === 'dangling')
            issues.push({
              kind: 'invalid-data-role-binding',
              stepId: n.id,
              input: i.id,
              message: `${c.executionPath ?? 'default'}: ${n.id}.${i.id}: ${i.state}`,
            });
    } catch {
      issues.push({
        kind: 'invalid-data-role-binding',
        stepId: '',
        input: '',
        message: 'invalid declarations or producer choice',
      });
    }
  }
  return issues;
}
