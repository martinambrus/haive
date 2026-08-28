import { z } from 'zod';

/**
 * The plan-canvas wire contract.
 *
 * Everything that writes a plan node — an LLM turn, a UI edit, the markdown
 * import — goes through ONE shape defined here and ONE applier
 * (`applyPlanPatch` in the worker). The alternative, letting the agent edit the
 * rendered markdown and diffing it back, is a lossy round-trip with no way to
 * express "move this subtree" or "reject this write, someone else got there
 * first". A patch of typed ops has both.
 */

export const planNodeKindSchema = z.enum(['component', 'decision', 'research', 'external']);
export type PlanNodeKind = z.infer<typeof planNodeKindSchema>;

export const planNodeStatusSchema = z.enum([
  'todo',
  'in_progress',
  'blocked_human',
  'done',
  'not_applicable',
]);
export type PlanNodeStatus = z.infer<typeof planNodeStatusSchema>;

export const planEdgeKindSchema = z.enum(['depends_on', 'affects', 'implements']);
export type PlanEdgeKind = z.infer<typeof planEdgeKindSchema>;

export const planNodeOriginSchema = z.enum(['user', 'llm', 'import']);
export type PlanNodeOrigin = z.infer<typeof planNodeOriginSchema>;

/** A node reference: either an existing node's uuid, or a patch-local temporary
 *  id the same patch introduces. Temp ids are what let ONE turn create a subtree
 *  and immediately link into it — without them an agent would need a round trip
 *  per level just to learn the ids it is about to reference. The applier resolves
 *  refs in op order, so a temp id must be introduced by an `upsert` before
 *  anything else names it. */
export const planNodeRefSchema = z.string().trim().min(1).max(128);

/** Create-or-update one node.
 *
 *  `parentRef` distinguishes three cases, and the distinction is why it is
 *  `.nullable().optional()` rather than plain optional:
 *    - absent   -> for an existing node, leave the parent alone; for a new one,
 *                  the applier rejects it (a new node must say where it goes).
 *    - null     -> this is the plan ROOT.
 *    - a ref    -> parent it here (a move, when the node already exists). */
/** A file (optionally a symbol within it) that implements a node. `evidence` is
 *  required in spirit if not in type: an impact list without it is an
 *  unfalsifiable claim, and a human cannot tell a real link from a guess. */
export const planCodeLinkSchema = z.object({
  repoPath: z.string().trim().min(1).max(1024),
  symbol: z.string().trim().max(512).optional(),
  evidence: z.string().max(2_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type PlanCodeLinkInput = z.infer<typeof planCodeLinkSchema>;

export const planUpsertOpSchema = z.object({
  op: z.literal('upsert'),
  nodeRef: planNodeRefSchema,
  parentRef: planNodeRefSchema.nullable().optional(),
  title: z.string().trim().min(1).max(512).optional(),
  body: z.string().max(200_000).nullable().optional(),
  kind: planNodeKindSchema.optional(),
  status: planNodeStatusSchema.optional(),
  taskable: z.boolean().optional(),
  ordinal: z.number().int().min(0).max(100_000).optional(),
  /** Files this node is implemented by. ADDITIVE — an agent that names three
   *  files does not thereby claim the other two the node already had are wrong.
   *  Removing a link is a separate, deliberate act. */
  codeLinks: z.array(planCodeLinkSchema).max(50).optional(),
  /** Optimistic-concurrency guard for an EXISTING node. A mismatch is a conflict
   *  the caller must surface, never a silent overwrite — two plan chats patching
   *  one node is the expected case, not an edge one. Omitted for a new node
   *  (there is nothing to have raced with). */
  expectedVersion: z.number().int().positive().optional(),
});

/** Delete a node and, by FK cascade, its whole subtree. */
export const planDeleteOpSchema = z.object({
  op: z.literal('delete'),
  nodeRef: planNodeRefSchema,
  expectedVersion: z.number().int().positive().optional(),
});

export const planLinkOpSchema = z.object({
  op: z.literal('link'),
  fromRef: planNodeRefSchema,
  toRef: planNodeRefSchema,
  kind: planEdgeKindSchema,
  note: z.string().max(2_000).nullable().optional(),
});

export const planUnlinkOpSchema = z.object({
  op: z.literal('unlink'),
  fromRef: planNodeRefSchema,
  toRef: planNodeRefSchema,
  kind: planEdgeKindSchema,
});

export const planPatchOpSchema = z.discriminatedUnion('op', [
  planUpsertOpSchema,
  planDeleteOpSchema,
  planLinkOpSchema,
  planUnlinkOpSchema,
]);
export type PlanPatchOp = z.infer<typeof planPatchOpSchema>;

/** Cap on ops per patch. One LLM turn cannot usefully emit more than this — a
 *  deep build fans out one agent per frontier node instead — and an unbounded
 *  array is an unbounded transaction. */
export const PLAN_PATCH_MAX_OPS = 500;

export const planPatchSchema = z.object({
  ops: z.array(planPatchOpSchema).max(PLAN_PATCH_MAX_OPS),
  /** Optional one-line summary of what the patch does, shown in the chat
   *  transcript beside the ops. Prose only; nothing branches on it. */
  summary: z.string().max(2_000).optional(),
});
export type PlanPatch = z.infer<typeof planPatchSchema>;

/* ------------------------------------------------------------------ */
/* Read shapes (API responses)                                         */
/* ------------------------------------------------------------------ */

/** One node as the API serves it. `directChildren`/`totalDescendants` are
 *  computed in SQL over `plan_nodes.path`, never by the client — the client is
 *  never sent the whole tree, so it could not count if it wanted to. */
export interface PlanNodeView {
  id: string;
  parentId: string | null;
  path: string;
  ordinal: number;
  title: string;
  kind: PlanNodeKind;
  body: string | null;
  status: PlanNodeStatus;
  taskable: boolean;
  version: number;
  createdBy: PlanNodeOrigin;
  sourceTaskId: string | null;
  directChildren: number;
  totalDescendants: number;
  /** Status after roll-up: `blocked_human` if any descendant is blocked, `done`
   *  only when every descendant is done or not-applicable. Derived at read time
   *  (see `rollUpStatus`), never stored — a stored copy needs a trigger and
   *  drifts the moment one is missed. */
  rolledStatus: PlanNodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlanEdgeView {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: PlanEdgeKind;
  note: string | null;
}

export interface PlanCodeLinkView {
  id: string;
  nodeId: string;
  repoPath: string;
  symbol: string | null;
  evidence: string | null;
  derivedAtCommit: string | null;
  confidence: number | null;
  stale: boolean;
}

export interface PlanMessageView {
  id: string;
  nodeId: string;
  taskId: string | null;
  role: 'user' | 'assistant';
  body: string;
  patch: PlanPatch | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Request bodies                                                      */
/* ------------------------------------------------------------------ */

export const createPlanNodeRequestSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(512),
  kind: planNodeKindSchema.optional(),
  body: z.string().max(200_000).optional(),
  taskable: z.boolean().optional(),
});
export type CreatePlanNodeRequest = z.infer<typeof createPlanNodeRequestSchema>;

export const updatePlanNodeRequestSchema = z.object({
  /** Required: every UI write races the same node's plan chats. */
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(512).optional(),
  body: z.string().max(200_000).nullable().optional(),
  kind: planNodeKindSchema.optional(),
  status: planNodeStatusSchema.optional(),
  taskable: z.boolean().optional(),
  parentId: z.string().uuid().nullable().optional(),
  ordinal: z.number().int().min(0).max(100_000).optional(),
});
export type UpdatePlanNodeRequest = z.infer<typeof updatePlanNodeRequestSchema>;

export const createPlanEdgeRequestSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  kind: planEdgeKindSchema,
  note: z.string().max(2_000).optional(),
});
export type CreatePlanEdgeRequest = z.infer<typeof createPlanEdgeRequestSchema>;

/** `from_repo` derives the plan from the repo's knowledge base + RAG;
 *  `from_md` decomposes a markdown document uploaded as a task attachment. */
export const planBuildModeSchema = z.enum(['from_repo', 'from_md']);
export type PlanBuildMode = z.infer<typeof planBuildModeSchema>;

/** A plan document carried inline with the build request.
 *
 *  Inline rather than a second upload call so the file and the task are created
 *  in ONE request: the build's `seed` hook writes it before the job is enqueued,
 *  and the worker starts immediately, so a separate upload would race detect.
 *
 *  Capped at 1 MiB where the streaming attachment route allows 25. That route is
 *  a stream and this is a JSON field; a MiB of markdown is roughly 250k words,
 *  far past any plan document, and anything larger belongs on an ordinary task
 *  as a normal attachment. */
export const planBuildDocumentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(1_048_576),
});
export type PlanBuildDocument = z.infer<typeof planBuildDocumentSchema>;

export const planBuildRequestSchema = z
  .object({
    mode: planBuildModeSchema,
    cliProviderId: z.string().uuid().optional(),
    title: z.string().trim().max(512).optional(),
    /** Free-text brief for a greenfield `from_md`-less build — what the product is
     *  meant to be, when there is no repo to read and no document to decompose. */
    description: z.string().max(100_000).optional(),
    /** The document `from_md` decomposes. Required by that mode, refused by the
     *  others. */
    document: planBuildDocumentSchema.optional(),
  })
  .refine((v) => v.mode !== 'from_md' || v.document !== undefined, {
    // The from_md prompt tells the agent to read "the attached document". Letting
    // that dispatch with nothing attached spends a CLI invocation drafting a plan
    // for a file that does not exist.
    message: 'from_md requires a document',
    path: ['document'],
  });
export type PlanBuildRequest = z.infer<typeof planBuildRequestSchema>;

export const planChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  cliProviderId: z.string().uuid().optional(),
});
export type PlanChatRequest = z.infer<typeof planChatRequestSchema>;

export const planAdvisoryRequestSchema = z.object({
  question: z.string().trim().max(20_000).optional(),
  cliProviderId: z.string().uuid().optional(),
});
export type PlanAdvisoryRequest = z.infer<typeof planAdvisoryRequestSchema>;

/* ------------------------------------------------------------------ */
/* Status roll-up                                                      */
/* ------------------------------------------------------------------ */

/** Roll a node's own status up against its descendants'.
 *
 *  Two rules, and the asymmetry between them is the point:
 *   - `blocked_human` anywhere below makes every ancestor render blocked. A
 *     non-code blocker (an unsigned contract, an undelivered domain) stops the
 *     branch just as hard as unwritten code does, and burying it at depth 5 is
 *     how it gets forgotten.
 *   - green requires EVERY descendant to be `done` or `not_applicable`.
 *     `not_applicable` must not prevent green — it is the "decided against"
 *     verdict, and treating it as outstanding would leave branches permanently
 *     amber for work nobody intends to do.
 *
 *  A node's OWN status wins when it has no descendants; with descendants it is
 *  the descendants that decide, because a parent marked done over unfinished
 *  children is a bookkeeping error, not a claim to be honoured.
 *
 *  Shared (not api-local) so the tree view, the card grid and the impact view
 *  cannot each grow their own slightly different idea of "green". */
export function rollUpStatus(own: PlanNodeStatus, descendants: PlanNodeStatus[]): PlanNodeStatus {
  if (descendants.length === 0) return own;
  if (own === 'blocked_human' || descendants.includes('blocked_human')) return 'blocked_human';
  const allSettled = descendants.every((s) => s === 'done' || s === 'not_applicable');
  if (allSettled) return own === 'not_applicable' ? 'not_applicable' : 'done';
  if (own === 'not_applicable') return 'not_applicable';
  return descendants.some((s) => s !== 'todo') || own !== 'todo' ? 'in_progress' : 'todo';
}
