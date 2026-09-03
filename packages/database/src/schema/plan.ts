import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth.js';
import { cliProviders } from './cli-providers.js';
import { repositories } from './repos.js';
import { tasks } from './tasks.js';

/**
 * The plan canvas: a durable, per-repo tree of what the project IS meant to be.
 *
 * Every other planning artifact in Haive is task-scoped and terminal — the
 * business-requirements doc (03b), the technical spec (04), the sprint DAG
 * (task_dag_*) all die with the task that produced them. The knowledge base is
 * durable but DESCRIPTIVE (how the code currently is), not INTENTIONAL. These
 * tables are the project-level counterpart: one plan per repo, drilling from
 * "the whole product" down to taskable leaves, with typed cross-links so
 * "if I change the backend here, what else must change?" has an answer.
 *
 * DB rows are the source of truth. The `.haive-data/plan.{json,md}` mirror is a
 * projection written at plan-step apply and re-imported on clone; the markdown
 * an LLM reads is rendered from these rows and the LLM returns structured node
 * patches, never edited markdown. One writer, auditable diffs, no lossy
 * round-trip.
 */

/** What a node represents.
 *  - component: a part of the system (the default, and what code links attach to).
 *  - decision: a choice to be made/recorded (stack, vendor, approach).
 *  - research: needs investigating before it can be decided (the `advisory` task type).
 *  - external: a non-code blocker outside the codebase — legal, a domain, hosting,
 *    an account. First-class because these gate their ancestors just as hard as
 *    unwritten code does, and nothing else in Haive can hold them. */
export const planNodeKindEnum = pgEnum('plan_node_kind', [
  'component',
  'decision',
  'research',
  'external',
]);

/** Per-node state. Roll-up to ancestors is DERIVED at read time, never stored:
 *  a parent renders green only when every descendant is `done` or
 *  `not_applicable`, and any `blocked_human` descendant makes its ancestors
 *  render blocked. Storing it would need a trigger and would drift. */
export const planNodeStatusEnum = pgEnum('plan_node_status', [
  'todo',
  'in_progress',
  /** Waiting on a human, not on an agent — an unsigned contract, an undelivered
   *  domain, a decision nobody has made. The one status that propagates upward. */
  'blocked_human',
  'done',
  'not_applicable',
]);

/** Typed cross-links between nodes. Hierarchy is `parent_id`; these are the
 *  NON-hierarchical relationships the impact view walks.
 *  - depends_on: this node cannot proceed until the target does.
 *  - affects: changing the target forces a change here (the impact edge).
 *  - implements: this node realises the target (a leaf implementing a decision). */
export const planEdgeKindEnum = pgEnum('plan_edge_kind', ['depends_on', 'affects', 'implements']);

/** Who wrote the node: a human in the UI, an LLM plan step, or the one-shot
 *  markdown import. Kept for the same reason `review_findings.reviewer_id` is:
 *  without it nothing can say whether the LLM decomposition is any good. */
export const planNodeOriginEnum = pgEnum('plan_node_origin', ['user', 'llm', 'import']);

/**
 * Revisioned outbox for the committed plan projection.
 *
 * Plan writes happen in both the API and worker, while the repository filesystem
 * is reconciled by the worker. Every portable-state transaction increments
 * `revision`; a mirror write advances `writtenRevision` only after both files
 * have been atomically replaced. `revision > writtenRevision` is therefore the
 * durable retry signal after a crash or a missed queue notification.
 */
export const planMirrorState = pgTable(
  'plan_mirror_state',
  {
    repositoryId: uuid('repository_id')
      .primaryKey()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(0),
    writtenRevision: integer('written_revision').notNull().default(0),
    lastError: text('last_error'),
    writtenAt: timestamp('written_at'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('plan_mirror_state_revision_nonnegative', sql`${table.revision} >= 0`),
    check('plan_mirror_state_written_nonnegative', sql`${table.writtenRevision} >= 0`),
    check(
      'plan_mirror_state_written_not_ahead',
      sql`${table.writtenRevision} <= ${table.revision}`,
    ),
    index('plan_mirror_state_dirty_idx')
      .on(table.repositoryId)
      .where(sql`${table.writtenRevision} < ${table.revision}`),
  ],
);

export const planNodes = pgTable(
  'plan_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** NULL = the plan root. Self-FK, cascade: deleting a node deletes its whole
     *  subtree, which is what "delete this component" means — a child with no
     *  parent is not a smaller plan, it is an orphan. */
    parentId: uuid('parent_id').references((): AnyPgColumn => planNodes.id, {
      onDelete: 'cascade',
    }),
    /** Materialised ancestry: '/<rootId>/<childId>/…/<selfId>/'. SELF-INCLUSIVE
     *  and slash-TERMINATED, both load-bearing. Self-inclusive so one predicate
     *  (`path LIKE node.path || '%'`) selects the node and its whole subtree, which
     *  is what the `(direct / total)` counts on every card are computed from — the
     *  client never counts. Slash-terminated so the prefix match is structural
     *  rather than accidentally correct: without it '/a/b' would prefix-match
     *  '/a/bc'. Recomputed for every descendant when a subtree moves (see
     *  applyPlanPatch), which is the price of making the read path one index scan. */
    path: text('path').notNull(),
    /** Sibling order under `parent_id`. Not unique — a reorder rewrites a whole
     *  sibling run, and a unique constraint would make that a multi-statement
     *  shuffle around collisions. */
    ordinal: integer('ordinal').notNull().default(0),
    title: varchar('title', { length: 512 }).notNull(),
    kind: planNodeKindEnum('kind').notNull().default('component'),
    /** This node's section of the plan, markdown. Rendered through MarkdownView
     *  like every other prose body in the product. */
    body: text('body'),
    status: planNodeStatusEnum('status').notNull().default('todo'),
    /** A leaf a workflow task can be created from. Not derived from "has no
     *  children": a component can be fully decomposed and still not be a unit of
     *  work, and a coarse node can be taskable before anyone has broken it down. */
    taskable: boolean('taskable').notNull().default(false),
    /** Optimistic concurrency. Two chats patching one node is the expected case
     *  (a chat rooted anywhere may patch anywhere), so every write carries an
     *  expectedVersion and a mismatch is a 409 the UI must surface — silently
     *  refetching would discard the loser's edit without telling anyone. */
    version: integer('version').notNull().default(1),
    createdBy: planNodeOriginEnum('created_by').notNull().default('user'),
    /** Which task last wrote this node. Set null (not cascade) so a node outlives
     *  the task that produced it — the plan is the point, the task is the receipt.
     *  Same reasoning as `step_guidance.source_task_id`. */
    sourceTaskId: uuid('source_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // One plan per repo, enforced on the ROOT rather than by a separate `plans`
    // table: a plans table would carry one column (repository_id) and buy a join
    // on every read.
    uniqueIndex('plan_nodes_one_root_per_repo_idx')
      .on(table.repositoryId)
      .where(sql`${table.parentId} IS NULL`),
    // The drill-down read: one level of children in sibling order.
    index('plan_nodes_repo_parent_ordinal_idx').on(
      table.repositoryId,
      table.parentId,
      table.ordinal,
    ),
    // Subtree queries are LIKE 'prefix%', which only uses an index under
    // text_pattern_ops (the default opclass is collation-aware and will not).
    index('plan_nodes_path_idx').using('btree', sql`${table.path} text_pattern_ops`),
  ],
);

export const planNodeEdges = pgTable(
  'plan_node_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Denormalised from the endpoints so the impact traversal and the repo-scoped
     *  edge fetch never join through plan_nodes. Both endpoints are always in the
     *  same repo — a link across two projects is not a thing this models. */
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    fromNodeId: uuid('from_node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    toNodeId: uuid('to_node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    kind: planEdgeKindEnum('kind').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('plan_node_edges_unique_idx').on(table.fromNodeId, table.toNodeId, table.kind),
    // Impact walks forward from a node; the reverse index answers "what points here".
    index('plan_node_edges_from_idx').on(table.fromNodeId),
    index('plan_node_edges_to_idx').on(table.toNodeId),
    index('plan_node_edges_repo_idx').on(table.repositoryId),
  ],
);

export const planNodeCodeLinks = pgTable(
  'plan_node_code_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    /** Repo-relative path. */
    repoPath: text('repo_path').notNull(),
    /** Optional symbol within the file (a class, a function, an export). */
    symbol: text('symbol'),
    /** Why the agent linked it. Without this an impact list is an unfalsifiable
     *  claim — a human cannot tell a real link from a hallucinated one. */
    evidence: text('evidence'),
    /** The commit the link was derived at, so a stale link can be dated rather
     *  than merely doubted. */
    derivedAtCommit: varchar('derived_at_commit', { length: 40 }),
    confidence: real('confidence'),
    /** Set by 11c-rag-reindex when a task changed this path. Link rot is the
     *  failure mode that makes an impact view LIE; this flag is the difference
     *  between a wrong answer and an old one. */
    stale: boolean('stale').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('plan_node_code_links_node_idx').on(table.nodeId),
    // "Which nodes does this file belong to" — the staleness marking pass.
    index('plan_node_code_links_repo_path_idx').on(table.repositoryId, table.repoPath),
    // coalesce(symbol,'') rather than the bare column: `symbol` is nullable and
    // Postgres treats NULLs as DISTINCT in a unique index, so a plain
    // (node, path, symbol) unique would let unlimited duplicate FILE-level links
    // through — which is the common case, not the edge one.
    uniqueIndex('plan_node_code_links_unique_idx').on(
      table.nodeId,
      table.repoPath,
      sql`coalesce(${table.symbol}, '')`,
    ),
  ],
);

export const planNodeMessages = pgTable(
  'plan_node_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    /** The plan_chat task that produced the turn. Set null: the transcript lives
     *  here precisely SO it survives — a self-targeting reviseLoop resets the step
     *  row every cycle, so the step's own output cannot hold chat history. */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** The CLI that produced this turn. Per MESSAGE rather than read off the
     *  task, because a conversation's provider can be changed mid-flight and
     *  the current one is not evidence of what answered earlier. Null on user
     *  turns and on rows written before this was recorded. */
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    role: varchar('role', { length: 16 }).notNull(),
    body: text('body').notNull(),
    /** The structured patch the assistant turn emitted, verbatim. The audit trail
     *  for "what did this conversation actually change". */
    patchJson: jsonb('patch_json').$type<unknown>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('plan_node_messages_node_created_idx').on(table.nodeId, table.createdAt)],
);

/**
 * How far a user has read one node's chat.
 *
 * Per user AND per node, not a watermark per repository: the badge has to say
 * WHICH node has a reply waiting, and a single timestamp would clear every
 * node's badge the moment any one conversation was read.
 *
 * A missing row means nothing has been read, so every assistant turn counts as
 * unread — the honest reading for a node whose chat you have never opened.
 */
export const userPlanNodeReads = pgTable(
  'user_plan_node_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.nodeId] })],
);

/** Why a task is attached to a plan node, and it decides whether finishing the
 *  task greens the node.
 *
 *  - implements: the task was created FROM this node. It IS the unit of work, so
 *    completing it means the node is done.
 *  - touched: the task changed code the node is linked to — recorded by the
 *    spec writer's affected-components pass. Provenance only. A task touching
 *    twelve components does not finish twelve components, and greening on
 *    "affected" would turn the canvas into a claim nobody made. */
export const planNodeTaskRoleEnum = pgEnum('plan_node_task_role', ['implements', 'touched']);

export const planNodeTasks = pgTable(
  'plan_node_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => planNodes.id, { onDelete: 'cascade' }),
    /** Cascade, unlike the provenance columns above: this row IS the link, so
     *  without the task it means nothing. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Defaults to `implements` so every row written before this column existed
     *  keeps the meaning it had: they all came from the create-task endpoint,
     *  which is the "created from this node" path. */
    role: planNodeTaskRoleEnum('role').notNull().default('implements'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // One row per (node, task): a task that was created FROM a node and also
    // touches it is still one relationship. The touched-writer inserts with
    // ON CONFLICT DO NOTHING so it can never downgrade an `implements` row.
    uniqueIndex('plan_node_tasks_unique_idx').on(table.nodeId, table.taskId),
    index('plan_node_tasks_task_idx').on(table.taskId),
  ],
);

export const planNodesRelations = relations(planNodes, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [planNodes.repositoryId],
    references: [repositories.id],
  }),
  parent: one(planNodes, {
    fields: [planNodes.parentId],
    references: [planNodes.id],
    relationName: 'planNodeParent',
  }),
  children: many(planNodes, { relationName: 'planNodeParent' }),
  sourceTask: one(tasks, { fields: [planNodes.sourceTaskId], references: [tasks.id] }),
  codeLinks: many(planNodeCodeLinks),
  messages: many(planNodeMessages),
  nodeTasks: many(planNodeTasks),
}));

export const planNodeEdgesRelations = relations(planNodeEdges, ({ one }) => ({
  repository: one(repositories, {
    fields: [planNodeEdges.repositoryId],
    references: [repositories.id],
  }),
  fromNode: one(planNodes, {
    fields: [planNodeEdges.fromNodeId],
    references: [planNodes.id],
    relationName: 'planEdgeFrom',
  }),
  toNode: one(planNodes, {
    fields: [planNodeEdges.toNodeId],
    references: [planNodes.id],
    relationName: 'planEdgeTo',
  }),
}));

export const planNodeCodeLinksRelations = relations(planNodeCodeLinks, ({ one }) => ({
  node: one(planNodes, { fields: [planNodeCodeLinks.nodeId], references: [planNodes.id] }),
  repository: one(repositories, {
    fields: [planNodeCodeLinks.repositoryId],
    references: [repositories.id],
  }),
}));

export const planNodeMessagesRelations = relations(planNodeMessages, ({ one }) => ({
  node: one(planNodes, { fields: [planNodeMessages.nodeId], references: [planNodes.id] }),
  task: one(tasks, { fields: [planNodeMessages.taskId], references: [tasks.id] }),
}));

export const planNodeTasksRelations = relations(planNodeTasks, ({ one }) => ({
  node: one(planNodes, { fields: [planNodeTasks.nodeId], references: [planNodes.id] }),
  task: one(tasks, { fields: [planNodeTasks.taskId], references: [tasks.id] }),
}));

export const planMirrorStateRelations = relations(planMirrorState, ({ one }) => ({
  repository: one(repositories, {
    fields: [planMirrorState.repositoryId],
    references: [repositories.id],
  }),
}));
