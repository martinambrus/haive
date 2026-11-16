import { type DataRoleBindingsDraft } from '@haive/shared/modularity';
import { parseDataEdgePlan, selectDataEdgeCandidate } from '@haive/shared/data-edge-plan';
import { dataPortNodes, validatePortEdges } from '@haive/shared/step-ports';
import { projectStepPorts } from '@haive/shared/step-ports';
import { parseDerivedRunPlan } from '@haive/shared/modularity';
import { readStepRole, STEP_ROLES, type RoleTaskPin } from '@haive/shared/step-outputs';
import type { StepCatalogRead, inspectDerivedDefinition } from '@haive/shared/modularity-server';

type Candidate = ReturnType<typeof inspectDerivedDefinition>['candidates'][number];
export function projectPortCandidates(
  candidates: readonly Pick<Candidate, 'executionPath' | 'stepIds' | 'roleBindings'>[],
  catalog: Pick<StepCatalogRead, 'composable'>,
  bindings: DataRoleBindingsDraft = [],
) {
  const labels = new Map([...catalog.composable].map(([id, entry]) => [id, entry.label]));
  return {
    candidates: candidates.map((candidate) => ({
      executionPath: candidate.executionPath,
      graph: projectStepPorts(candidate.stepIds, {
        labels,
        roleBindings: candidate.roleBindings,
        declarations: catalog.composable,
        dataRoleBindings: bindings,
        executionPath: candidate.executionPath,
      }),
    })),
  };
}

/** Only call after the route's owner predicate. Historical edges never consult a live type/catalog. */
export function projectTaskPorts(
  task: RoleTaskPin,
  steps: readonly { stepId: string; title?: string | null }[],
) {
  const labels = new Map(steps.map((step) => [step.stepId, step.title ?? step.stepId]));
  if (task.dataEdgePlan != null) {
    const plan = parseDataEdgePlan(task.dataEdgePlan);
    const candidate = selectDataEdgeCandidate({ ...task, dataEdgePlan: task.dataEdgePlan }, plan);
    const ids = [...new Set([...candidate.nodes.map((n) => n.id), ...steps.map((s) => s.stepId)])];
    const canonical = dataPortNodes(ids, undefined, undefined, true);
    const nodes = ids.map((id) => {
      const pinned = candidate.nodes.find((n) => n.id === id),
        current = canonical.find((n) => n.id === id)!;
      return {
        ...(pinned ?? current),
        label: labels.get(id) ?? id,
        inputs: [
          ...(pinned?.inputs ?? []),
          ...current.inputs.filter((i) => !pinned?.inputs.some((p) => p.id === i.id)),
        ],
        outputs: [
          ...(pinned?.outputs ?? []),
          ...current.outputs.filter((o) => !pinned?.outputs.some((p) => p.id === o.id)),
        ],
      };
    });
    const bindings: Record<string, number | null> = {};
    const canonicalInputs = new Set<string>();
    candidate.nodes.forEach((n, index) =>
      n.inputs.forEach((i) => {
        const b = candidate.bindings[`${index}:${i.id}`];
        bindings[`${ids.indexOf(n.id)}:${i.id}`] = b ? ids.indexOf(b.producerStepId) : null;
      }),
    );
    // Inputs absent at admission read canonically, even beside a newer alternative producer.
    nodes.forEach((n, index) =>
      n.inputs.forEach((i) => {
        if (Object.hasOwn(bindings, `${index}:${i.id}`)) return;
        canonicalInputs.add(`${index}:${i.id}`);
        const source = canonical.find((node) => node.outputs.some((o) => o.role === i.role));
        bindings[`${index}:${i.id}`] = source ? ids.indexOf(source.id) : null;
      }),
    );
    const graph = validatePortEdges(nodes, bindings);
    // A canonical compatibility read is not a new admitted edge: legacy reads can
    // reach a historical producer outside the old candidate's run positions.
    graph.nodes.forEach((n, targetIndex) =>
      n.inputs.forEach((i) => {
        if (!canonicalInputs.has(`${targetIndex}:${i.id}`) || i.state === 'wired') return;
        const sourceIndex = bindings[`${targetIndex}:${i.id}`];
        if (sourceIndex == null || sourceIndex < 0) return;
        const source = nodes[sourceIndex]!,
          output = source.outputs.find((o) => o.role === i.role);
        if (!output) return;
        graph.edges.push({
          source: source.id,
          sourceIndex,
          sourcePort: output.id,
          target: n.id,
          targetIndex,
          targetPort: i.id,
        });
        i.state = 'wired';
      }),
    );
    return {
      candidatesOnly: plan.selection === 'derived' && task.executionPath == null,
      candidates: [
        {
          // A static pin has one path-less candidate; the canvas keys on the task's chosen path.
          executionPath:
            plan.selection === 'static' ? (task.executionPath ?? null) : candidate.executionPath,
          graph,
        },
      ],
    };
  }
  if (task.derivedRunPlan != null || task.runListStrategy === 'derived') {
    const plan = parseDerivedRunPlan(task.derivedRunPlan);
    // Reuse the strict pin reader's selected-path/snapshot consistency fence.
    for (const role of Object.values(STEP_ROLES))
      readStepRole(task, role, (binding) => binding, plan);
    return {
      candidatesOnly: task.executionPath == null,
      candidates: plan.candidates
        .filter((candidate) => candidate.executionPath === (task.executionPath ?? null))
        .map((candidate) => ({
          executionPath: candidate.executionPath,
          graph: projectStepPorts(candidate.stepIds, {
            canonicalLegacy: true,
            labels,
            roleBindings: task.executionPath == null ? undefined : candidate.roleBindings,
          }),
        })),
    };
  }
  const ids = task.runListSnapshot ?? [...new Set(steps.map((step) => step.stepId))];
  return {
    candidates: [
      {
        executionPath: task.executionPath ?? null,
        graph: projectStepPorts(ids, { labels, canonicalLegacy: true }),
      },
    ],
  };
}
