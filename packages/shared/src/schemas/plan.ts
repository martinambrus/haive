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

/* ------------------------------------------------------------------ */
/* Repository mirror                                                   */
/* ------------------------------------------------------------------ */

const planMirrorNodeBaseSchema = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    ordinal: z.number().int().min(0).max(100_000),
    title: z.string().trim().min(1).max(512),
    kind: planNodeKindSchema,
    body: z.string().max(200_000).nullable(),
    status: planNodeStatusSchema,
    taskable: z.boolean(),
  })
  .strict();

const planMirrorEdgeSchema = z
  .object({
    fromNodeId: z.string().uuid(),
    toNodeId: z.string().uuid(),
    kind: planEdgeKindSchema,
    note: z.string().max(2_000).nullable(),
  })
  .strict();

/** A code path committed into the repository may never escape that repository
 *  when it is restored. Keep this browser-safe (no node:path import) because the
 *  plan schemas are also used by the web package. */
const portableRepoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(p) &&
      !p.split(/[\\/]/).includes('..') &&
      !p.includes('\0'),
    'code link must be a safe repository-relative path',
  );

export const planMirrorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z
      .array(planMirrorNodeBaseSchema.extend({ createdBy: planNodeOriginSchema }).strict())
      .min(1)
      .max(20_000),
    edges: z.array(planMirrorEdgeSchema).max(100_000),
  })
  .strict();

export const planMirrorV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    nodes: z.array(planMirrorNodeBaseSchema).min(1).max(20_000),
    edges: z.array(planMirrorEdgeSchema).max(100_000),
    codeLinks: z
      .array(
        z
          .object({
            nodeId: z.string().uuid(),
            repoPath: portableRepoPathSchema,
            symbol: z.string().trim().max(512).nullable(),
            evidence: z.string().max(2_000).nullable(),
            derivedAtCommit: z.string().max(40).nullable(),
            stale: z.boolean(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

export const planMirrorPayloadSchema = z.discriminatedUnion('schemaVersion', [
  planMirrorV1Schema,
  planMirrorV2Schema,
]);
export type PlanMirrorPayloadInput = z.infer<typeof planMirrorPayloadSchema>;

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
  repoPath: portableRepoPathSchema,
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
  /** 1-based position in build order — a POST-ORDER index over the tree, so
   *  every descendant is numbered before its container. Derived at read time by
   *  `computePlanSequence` for the same reason `rolledStatus` is, plus one of
   *  its own: inserting a node shifts every number after it, which stored would
   *  be thousands of row updates inside the applier's transaction.
   *
   *  It names a SLOT in the current plan, not a thing. Never persist one, and
   *  never use one to refer to a node across time. */
  sequence: number;
  /** This node's own unmet `depends_on` targets, lowest number first. Empty for
   *  a node that is ready to start. Direct only — never inherited from an
   *  ancestor. */
  blockedBy: PlanBlocker[];
  createdAt: string;
  updatedAt: string;
}

/** One unmet prerequisite, named the way a person reads it. Declared here beside
 *  the other wire shapes rather than in `plan/sequence.ts`, which computes it:
 *  that module imports this one, and the reverse would be a cycle. */
export interface PlanBlocker {
  nodeId: string;
  sequence: number;
  title: string;
}

/** A node named in a defect report: enough to render it and to click through. */
export interface PlanDefectNodeView {
  nodeId: string;
  sequence: number;
  title: string;
}

/** Dependency knots that can NEVER resolve, as distinct from work that is
 *  merely waiting. A property of the plan rather than of any one node — a cycle
 *  has two ends and neither is the place to report it — so this rides the
 *  overview, not a node view. */
export interface PlanDefectsView {
  /** `depends_on` loops. Every member is permanently blocked by the others. */
  cycles: PlanDefectNodeView[][];
  /** A node depending on its own ancestor: the roll-up cannot green the
   *  ancestor while the descendant waiting on it is outstanding. */
  ancestorDeps: { from: PlanDefectNodeView; to: PlanDefectNodeView }[];
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

/** `from_repo` derives the plan from the repo's knowledge base + RAG, and its
 *  nodes arrive `done` because they describe code that already exists.
 *  `greenfield` decomposes a written brief plus any attached documents into a
 *  project that does NOT exist yet, so its nodes stay `todo`.
 *
 *  A third value, `from_md`, was how a single inline markdown document used to
 *  arrive. It is deliberately absent HERE while remaining live in the worker:
 *  nothing may newly create one, but tasks already carrying it must keep
 *  running. A brief-only build used to ride `from_repo`, which was not merely
 *  inaccurate prompt copy — it greened every node of a project nobody had
 *  built. */
export const planBuildModeSchema = z.enum(['from_repo', 'greenfield']);
export type PlanBuildMode = z.infer<typeof planBuildModeSchema>;

export const planBuildRequestSchema = z
  .object({
    mode: planBuildModeSchema,
    cliProviderId: z.string().uuid().optional(),
    title: z.string().trim().max(512).optional(),
    /** The brief: what the product is meant to be, when there is no repo to read.
     *  Authoritative for `greenfield` alongside the attachments. */
    description: z.string().max(100_000).optional(),
    /** Create the task but do NOT enqueue it: the caller is about to stream
     *  attachments and will finalize with the `start` task action once they all
     *  land. The worker picks a job up immediately, so uploading after the
     *  enqueue races the first step's detect — which is the whole reason this
     *  flag exists rather than a create-then-upload sequence. */
    deferStart: z.boolean().optional(),
  })
  .refine((v) => v.mode !== 'greenfield' || Boolean(v.description?.trim()) || v.deferStart, {
    // A greenfield build with no brief and no incoming files has nothing to
    // decompose, and dispatching it spends a CLI invocation to invent a project.
    // `deferStart` is accepted in place of a brief because attachments have not
    // been uploaded yet at this point; the worker re-checks once both are known
    // and refuses there if neither arrived.
    message: 'greenfield requires a description or attachments',
    path: ['description'],
  });
export type PlanBuildRequest = z.infer<typeof planBuildRequestSchema>;

/** Put an EXISTING plan into build order. No mode and no brief: the plan is
 *  already there and the only input is which CLI to spend. */
export const planSequenceRequestSchema = z.object({
  cliProviderId: z.string().uuid().optional(),
});
export type PlanSequenceRequest = z.infer<typeof planSequenceRequestSchema>;

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

export const planSnapshotSaveRequestSchema = z.object({
  push: z.boolean().optional().default(false),
  commitMessage: z.string().trim().min(1).max(500).optional(),
});
export type PlanSnapshotSaveRequest = z.infer<typeof planSnapshotSaveRequestSchema>;

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
