import { indexChildren, planNodeDepth, type PlanNodeSkeleton } from '@haive/shared/plan';

/**
 * Provider-neutral character budget for the plan context in one decomposition
 * prompt. The smallest supported model fallback is 128k TOKENS; keeping this
 * block below 96k CHARACTERS leaves ample room for the instructions, task
 * ledger, adapter additions, and the model's response on every supported CLI.
 *
 * This is deliberately not Codex's 1 MiB transport ceiling. A prompt that only
 * fits the most permissive adapter is already too large for the product's
 * provider-independent step contract.
 */
export const PLAN_EXPANSION_CONTEXT_MAX_CHARS = 96_000;

const TITLE_MAX_CHARS = 180;

function compactTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim();
  return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

function exactLine(node: PlanNodeSkeleton, role: string): string {
  const flags = [node.kind, node.status, ...(node.taskable ? ['taskable'] : [])].join(', ');
  return `- ${role}: ${compactTitle(node.title)} (\`node:${node.id}\`, ${flags})`;
}

function outlineLine(node: PlanNodeSkeleton): string {
  const depth = planNodeDepth(node.path);
  const indent = '  '.repeat(Math.min(depth, 8));
  const depthSuffix = depth > 8 ? `, depth ${depth}` : '';
  return `${indent}- ${compactTitle(node.title)} [${node.kind}, ${node.status}${depthSuffix}]`;
}

function treeOrder(nodes: PlanNodeSkeleton[]): PlanNodeSkeleton[] {
  const byParent = indexChildren(nodes);
  const seen = new Set<string>();
  const ordered: PlanNodeSkeleton[] = [];
  const visit = (node: PlanNodeSkeleton): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    for (const child of byParent.get(node.id) ?? []) visit(child);
  };
  for (const root of byParent.get(null) ?? []) visit(root);
  // Defensive: retain an orphan whose parent row was removed or imported late.
  for (const node of nodes) visit(node);
  return ordered;
}

function evenlySample(lines: string[], available: number): string[] {
  if (lines.join('\n').length <= available) return lines;
  if (available <= 0 || lines.length === 0) return [];

  const average = lines.reduce((sum, line) => sum + line.length + 1, 0) / lines.length;
  let count = Math.max(1, Math.min(lines.length, Math.floor(available / Math.max(1, average))));

  while (count > 0) {
    const indices = new Set<number>();
    if (count === 1) {
      indices.add(0);
    } else {
      for (let i = 0; i < count; i += 1) {
        indices.add(Math.round((i * (lines.length - 1)) / (count - 1)));
      }
    }
    const sampled = [...indices].map((index) => lines[index]!);
    if (sampled.join('\n').length <= available) return sampled;
    count = Math.floor(count * 0.9);
  }
  return [];
}

/**
 * Compact decomposition context with two guarantees:
 *
 * 1. The target and its ancestors retain exact node refs. Siblings and direct
 *    children retain exact refs when they fit and are evenly sampled for an
 *    abnormally wide neighborhood.
 * 2. Dependency edges and bodies are omitted. Repeating thousands of verbose
 *    edge lines made the measured prompt grow from 863k to 1.19m characters,
 *    while titles and hierarchy are the evidence an expansion agent actually
 *    needs to avoid duplicating a sibling.
 */
export function buildPlanExpansionContext(
  nodes: PlanNodeSkeleton[],
  focus: PlanNodeSkeleton,
  maxChars = PLAN_EXPANSION_CONTEXT_MAX_CHARS,
): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byParent = indexChildren(nodes);

  const ancestors: PlanNodeSkeleton[] = [];
  let parentId = focus.parentId;
  const ancestorSeen = new Set<string>();
  while (parentId) {
    if (ancestorSeen.has(parentId)) break;
    ancestorSeen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }

  const exactPathLines = [
    ...ancestors.map((ancestor) => exactLine(ancestor, 'Ancestor')),
    exactLine(focus, 'Target'),
  ];
  const neighborLines = [
    ...(byParent.get(focus.parentId) ?? [])
      .filter((sibling) => sibling.id !== focus.id)
      .map((sibling) => exactLine(sibling, 'Sibling')),
    ...(byParent.get(focus.id) ?? []).map((child) => exactLine(child, 'Existing child')),
  ];

  const localHeader = '## Target neighborhood (exact refs)';
  // Normal expansion is capped at 12 children, but imported plans can be much
  // wider. Reserve most of the provider-neutral budget for whole-plan context
  // instead of allowing one pathological sibling set to consume it all.
  const localBudget = Math.min(24_000, Math.max(4_000, Math.floor(maxChars / 3)));
  const localFixedChars = localHeader.length + exactPathLines.join('\n').length + 2 + 120;
  const sampledNeighbors = evenlySample(neighborLines, Math.max(0, localBudget - localFixedChars));
  const localSamplingNote =
    sampledNeighbors.length === neighborLines.length
      ? `Showing all ${neighborLines.length} sibling/direct-child ref(s).`
      : `Showing ${sampledNeighbors.length} evenly sampled sibling/direct-child ref(s) from ${neighborLines.length}.`;
  const local = [localHeader, ...exactPathLines, localSamplingNote, ...sampledNeighbors, ''].join(
    '\n',
  );
  const ordered = treeOrder(nodes);
  const allOutlineLines = ordered.map(outlineLine);
  const outlineHeader =
    '## Whole-plan title index (bodies and dependency edges omitted for prompt safety)';
  let sampled = evenlySample(
    allOutlineLines,
    Math.max(0, maxChars - local.length - outlineHeader.length - 160),
  );
  // The note contains the selected count, so calculate the exact fixed size
  // after the first estimate and trim complete lines until the hard cap holds.
  while (true) {
    const samplingNote =
      sampled.length === allOutlineLines.length
        ? `Showing all ${allOutlineLines.length} nodes.`
        : `Showing ${sampled.length} evenly sampled title(s) from ${allOutlineLines.length} nodes; the target neighborhood above may also be sampled.`;
    const result = [local, outlineHeader, samplingNote, ...sampled].join('\n');
    if (result.length <= maxChars || sampled.length === 0) return result;
    sampled.pop();
  }
}
