// Server-only pin codec. The browser-safe port declarations live in core-data-ports.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_DATA_PORT_STEPS, validatePortEdges, type PortNode } from './step-ports.js';
import { executionPathSchema } from '../schemas/tasks.js';

export const MAX_DATA_EDGE_STEPS = MAX_DATA_PORT_STEPS;
export class DataEdgePlanError extends Error {
  readonly code = 'invalid-data-edge-plan';
  constructor(reason = 'malformed or missing pin') {
    super(`invalid-data-edge-plan: ${reason}`);
    this.name = 'DataEdgePlanError';
  }
}
const ref = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.number().int().positive(),
});
const declaration = z.strictObject({
  id: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  contract: ref,
  optional: z.boolean(),
  authorship: z.enum(['agent', 'human', 'host', 'mixed']),
});
const node = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().max(256),
  inputs: z.array(declaration).max(32),
  outputs: z.array(declaration).max(32),
});
const binding = z.strictObject({
  producerIndex: z.number().int().nonnegative(),
  producerStepId: z.string(),
  output: z.string(),
  role: z.string(),
  contract: ref,
});
const candidate = z.strictObject({
  executionPath: executionPathSchema.nullable(),
  nodes: z.array(node).max(MAX_DATA_EDGE_STEPS),
  bindings: z.record(z.string(), binding.nullable()),
});
const payload = z.strictObject({
  version: z.literal(3),
  selection: z.enum(['static', 'workflow', 'derived']),
  candidates: z.array(candidate).min(1).max(16),
});
const planSchema = payload.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type DataEdgePlan = z.infer<typeof planSchema>;
export type DataEdgeCandidate = DataEdgePlan['candidates'][number];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
/** Bounds apply before the potentially quadratic candidate identities are produced. */
export function buildDataEdgePlan(
  selection: DataEdgePlan['selection'],
  candidates: readonly {
    executionPath: DataEdgeCandidate['executionPath'];
    nodes: readonly PortNode[];
    bindings?: Readonly<Record<string, number>>;
  }[],
  maxSteps = MAX_DATA_EDGE_STEPS,
): DataEdgePlan {
  const pinned = candidates.map((c) => {
    if (c.nodes.length > maxSteps)
      throw new DataEdgePlanError('step-count exceeds admission limit');
    const graph = validatePortEdges(c.nodes, c.bindings);
    const bindings: DataEdgeCandidate['bindings'] = {};
    graph.nodes.forEach((n, index) =>
      n.inputs.forEach((i) => {
        const key = `${index}:${i.id}`;
        if (i.state === 'ambiguous' || i.state === 'dangling')
          throw new DataEdgePlanError(`${n.id}.${i.id}: ${i.state}`);
        const edge = graph.edges.find((e) => e.targetIndex === index && e.targetPort === i.id);
        const producer =
          edge && c.nodes[edge.sourceIndex]!.outputs.find((o) => o.id === edge.sourcePort)!;
        bindings[key] =
          edge && producer
            ? {
                producerIndex: edge.sourceIndex,
                producerStepId: edge.source,
                output: edge.sourcePort,
                role: producer.role,
                contract: { ...producer.contract },
              }
            : null;
      }),
    );
    return {
      executionPath: c.executionPath,
      nodes: c.nodes.map((n) => ({
        id: n.id,
        label: n.id,
        inputs: n.inputs.map((i) => ({ ...i })),
        outputs: n.outputs.map((o) => ({ ...o })),
      })),
      bindings,
    };
  });
  const value = { version: 3 as const, selection, candidates: pinned };
  return parseDataEdgePlan({ ...value, fingerprint: fingerprint(value) });
}
/** Validate pinned structure and exact edges, never today's declarations or composition. */
export function parseDataEdgePlan(raw: unknown): DataEdgePlan {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new DataEdgePlanError();
  const { fingerprint: hash, ...value } = parsed.data;
  if (fingerprint(value) !== hash) throw new DataEdgePlanError('fingerprint mismatch');
  const paths = new Set<unknown>();
  for (const c of value.candidates) {
    if (paths.has(c.executionPath)) throw new DataEdgePlanError('duplicate candidate');
    paths.add(c.executionPath);
    if (new Set(c.nodes.map((n) => n.id)).size !== c.nodes.length)
      throw new DataEdgePlanError('duplicate step');
    const keys = new Set<string>();
    c.nodes.forEach((n, index) => {
      if (
        new Set(n.inputs.map((i) => i.id)).size !== n.inputs.length ||
        new Set(n.outputs.map((o) => o.id)).size !== n.outputs.length
      )
        throw new DataEdgePlanError('duplicate port');
      for (const i of n.inputs) {
        const key = `${index}:${i.id}`;
        keys.add(key);
        if (!Object.hasOwn(c.bindings, key)) throw new DataEdgePlanError('missing input binding');
        const b = c.bindings[key];
        if (b === null) {
          if (!i.optional) throw new DataEdgePlanError('required input absent');
          continue;
        }
        if (!b || b.producerIndex >= index) throw new DataEdgePlanError('producer must be earlier');
        const p = c.nodes[b.producerIndex];
        const o = p?.outputs.find((o) => o.id === b.output);
        if (
          !p ||
          p.id !== b.producerStepId ||
          !o ||
          o.role !== i.role ||
          b.role !== i.role ||
          o.contract.id !== i.contract.id ||
          o.contract.version !== i.contract.version ||
          b.contract.id !== i.contract.id ||
          b.contract.version !== i.contract.version
        )
          throw new DataEdgePlanError('incompatible binding');
      }
    });
    if (Object.keys(c.bindings).some((key) => !keys.has(key)))
      throw new DataEdgePlanError('unknown input binding');
  }
  if (!paths.has(null) || (value.selection === 'static' && value.candidates.length !== 1))
    throw new DataEdgePlanError('candidate selection');
  return parsed.data;
}
export function selectDataEdgeCandidate(
  task: {
    dataEdgePlan: unknown;
    executionPath?: string | null;
    runListSnapshot?: readonly string[] | null;
  },
  parsed = parseDataEdgePlan(task.dataEdgePlan),
): DataEdgeCandidate {
  const path = parsed.selection === 'static' ? null : (task.executionPath ?? null);
  const c = parsed.candidates.find((c) => c.executionPath === path);
  if (!c) throw new DataEdgePlanError('unknown candidate');
  if (
    task.runListSnapshot != null &&
    JSON.stringify(task.runListSnapshot) !== JSON.stringify(c.nodes.map((n) => n.id))
  )
    throw new DataEdgePlanError('snapshot mismatch');
  return c;
}
export function resolveDataInput(
  task: Parameters<typeof selectDataEdgeCandidate>[0],
  consumer: string,
  input: string,
  p = parseDataEdgePlan(task.dataEdgePlan),
) {
  const c = selectDataEdgeCandidate(task, p);
  if (p.selection === 'derived' && task.executionPath == null)
    return { state: 'unselected' as const };
  const index = c.nodes.findIndex((n) => n.id === consumer);
  const declaration = c.nodes[index]?.inputs.find((i) => i.id === input);
  if (!declaration) throw new DataEdgePlanError(`unknown consumer input ${consumer}.${input}`);
  const b = c.bindings[`${index}:${input}`];
  return b
    ? { state: 'active' as const, binding: b, declaration }
    : { state: 'absent' as const, declaration };
}
