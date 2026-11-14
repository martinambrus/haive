import type { PlanNodeRecord, PlanEdgeRecord } from '@haive/shared/plan';
import { PLAN_CHAT_MESSAGE_MAX_CHARS } from '@haive/shared/schemas';
import { fencedAgentBlock, collapseToLine } from '../_untrusted-repo.js';
import { renderBoundedPlanIndexParts } from './_plan-index.js';
import { PLAN_EXPANSION_CONTEXT_MAX_CHARS } from './_plan-expansion-context.js';

export const PLAN_CHAT_HISTORY_MAX_CHARS = 24_000;
// Conservative character admission for the smallest supported context. Output is
// reserved before any optional context; dispatch measures all actual additions.
export const PLAN_CHAT_TOTAL_MAX_CHARS = 128_000;
export const PLAN_CHAT_OUTPUT_RESERVE_CHARS = 32_000;
export const PLAN_CHAT_SNAPSHOT_PATH = '/haive/plan-chat-snapshot.json';
export interface ChatPlanRead {
  nodes: PlanNodeRecord[];
  edges: PlanEdgeRecord[];
}

export function chatTranscript(
  transcript: { role: string; body: string }[],
  pending: string,
  maxChars = PLAN_CHAT_HISTORY_MAX_CHARS,
): string {
  if (pending.length > PLAN_CHAT_MESSAGE_MAX_CHARS)
    throw new Error('The pending plan message needs a user edit.');
  const messages = [...transcript];
  if (messages.at(-1)?.role !== 'user' || messages.at(-1)?.body !== pending)
    messages.push({ role: 'user', body: pending });
  const render = (m: { role: string; body: string }) =>
    m.role === 'user' ? `User: ${m.body}` : `You:\n${fencedAgentBlock(m.body)}`;
  const kept = [render(messages.at(-1)!)];
  // Reserve the dropped-count line as well as separators before packing turns.
  const reserve = `(${messages.length} earlier turns of this conversation are not shown)\n\n`
    .length;
  let size = kept[0]!.length + reserve;
  if (size > maxChars)
    throw new Error('The prompt has no room for the whole pending plan message.');
  for (let i = messages.length - 2; i >= 0; i--) {
    const next = render(messages[i]!);
    if (size + next.length + 2 > maxChars) break;
    kept.unshift(next);
    size += next.length + 2;
  }
  const dropped = messages.length - kept.length;
  return [
    ...(dropped ? [`(${dropped} earlier turns of this conversation are not shown)`] : []),
    ...kept,
  ].join('\n\n');
}

/** All optional units use the same immutable read, including index versions. */
export function chatPlanContext(read: ChatPlanRead, focusId: string, budget: number): string {
  const max = Math.min(budget, PLAN_EXPANSION_CONTEXT_MAX_CHARS);
  // Account for headings, fences, cut notices and joins before allocating shares.
  if (max < 1800) {
    const notice = 'Plan context omitted for size; read the versioned dispatch snapshot.';
    if (notice.length > max) throw new Error('No room for the plan-context omission notice.');
    return notice;
  }
  const indexShare = Math.floor((max - 800) * 0.4);
  const index = renderBoundedPlanIndexParts({ ...read, withVersions: true }, '', indexShare);
  const indexBlock = `## Bounded plan index\n${fencedAgentBlock(index.text)}${index.notice ?? ''}`;
  const available = max - indexBlock.length - 400;
  const byId = new Map(read.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  const ids = new Set<string>([focusId]);
  for (
    let parent = focus?.parentId;
    parent && !ids.has(parent);
    parent = byId.get(parent)?.parentId
  )
    ids.add(parent);
  for (const n of read.nodes)
    if (n.parentId === focusId || (focus && n.parentId === focus.parentId)) ids.add(n.id);
  for (const e of read.edges)
    if (e.fromNodeId === focusId || e.toNodeId === focusId) {
      ids.add(e.fromNodeId);
      ids.add(e.toNodeId);
    }
  const blocks: string[] = [];
  let omitted = 0;
  let used = 0;
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    const block =
      `### ${collapseToLine(n.title)}\nnode:${n.id}, version ${n.version}, ${n.kind}, ${n.status}\n${n.body ?? ''}\n` +
      read.edges
        .filter((e) => e.fromNodeId === id)
        .map(
          (e) =>
            `- ${e.kind}: node:${e.toNodeId}, version ${byId.get(e.toNodeId)?.version ?? 'unknown'} ${e.note ? collapseToLine(e.note) : ''}`,
        )
        .join('\n');
    const rendered = fencedAgentBlock(block);
    if (used + rendered.length + 2 > available) {
      omitted++;
      continue;
    }
    blocks.push(rendered);
    used += rendered.length + 2;
  }
  const result = `## Focus neighbourhood with bodies\n${blocks.join('\n\n')}\nNeighbourhood: ${omitted} whole node(s) omitted for size; read their bodies and versions in the dispatch snapshot.\n\n${indexBlock}`;
  if (result.length > max) throw new Error('Plan chat context allocation exceeded its budget.');
  return result;
}
