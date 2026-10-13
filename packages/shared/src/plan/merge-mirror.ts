import type { PlanMirror, PlanMirrorPayload } from '../types/index.js';

type MirrorNode = PlanMirror['nodes'][number];
type MirrorEdge = PlanMirror['edges'][number];
type MirrorCodeLink = PlanMirror['codeLinks'][number];

/** Fields a person is asked about when both sides changed one differently. */
export const PLAN_MIRROR_ASKED_FIELDS = ['title', 'body', 'kind', 'status', 'taskable'] as const;
export type PlanMirrorAskedField = (typeof PLAN_MIRROR_ASKED_FIELDS)[number];

export interface PlanMirrorConflict {
  nodeId: string;
  field: PlanMirrorAskedField;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

export type PlanMirrorReportKind = 'local-wins' | 'kept-modified' | 'kept-ancestor';

/** A decision the merge made without asking. `subject` is a node id, `edge:<from>><to>:<kind>` or
 *  `code-link:<node>:<path>:<symbol>`. `deletedBy` is the side whose deletion lost. */
export interface PlanMirrorReport {
  kind: PlanMirrorReportKind;
  subject: string;
  field?: string;
  deletedBy?: 'local' | 'incoming';
  local?: unknown;
  incoming?: unknown;
}

export interface PlanMirrorMergeInput {
  /** The mirror at the last head both sides shared; null when there is none (a first import). */
  base: PlanMirrorPayload | null;
  local: PlanMirrorPayload;
  incoming: PlanMirrorPayload;
}

export interface PlanMirrorMerge {
  /** A contested asked field keeps the INCOMING value here; the caller decides what the database holds. */
  merged: PlanMirror;
  conflicts: PlanMirrorConflict[];
  /** Local nodes the incoming side deleted and nothing kept, deepest first. */
  deleted: string[];
  /** Nodes local lacks that the merge brings back from incoming, with the ancestors they need. */
  resurrected: string[];
  reported: PlanMirrorReport[];
}

interface Side {
  nodes: MirrorNode[];
  byId: Map<string, MirrorNode>;
  edges: MirrorEdge[];
  links: MirrorCodeLink[];
}

function readSide(payload: PlanMirrorPayload): Side {
  const nodes = payload.nodes.map((n): MirrorNode => ({
    id: n.id,
    parentId: n.parentId,
    ordinal: n.ordinal,
    title: n.title,
    kind: n.kind,
    body: n.body,
    status: n.status,
    taskable: n.taskable,
  }));
  return {
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    edges: payload.edges,
    links: payload.schemaVersion === 2 ? payload.codeLinks : [],
  };
}

function pick3<T>(base: T | undefined, local: T, incoming: T): { value: T; contested: boolean } {
  if (local === incoming) return { value: local, contested: false };
  if (base === local) return { value: incoming, contested: false };
  if (base === incoming) return { value: local, contested: false };
  return { value: local, contested: true };
}

const nodeModified = (a: MirrorNode, b: MirrorNode): boolean =>
  a.parentId !== b.parentId ||
  a.ordinal !== b.ordinal ||
  PLAN_MIRROR_ASKED_FIELDS.some((f) => a[f] !== b[f]);

type Candidate = 'deleted-by-incoming' | 'deleted-by-local' | null;

interface Entry {
  node: MirrorNode;
  rank: number;
  inLocal: boolean;
  parentFromIncoming: boolean;
  candidate: Candidate;
}

function findCycle(entries: Map<string, Entry>): string[] | null {
  const done = new Set<string>();
  for (const start of entries.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string | null = start;
    while (cur !== null && !done.has(cur)) {
      const seenAt = onPath.get(cur);
      if (seenAt !== undefined) return path.slice(seenAt);
      onPath.set(cur, path.length);
      path.push(cur);
      cur = entries.get(cur)?.node.parentId ?? null;
    }
    for (const id of path) done.add(id);
  }
  return null;
}

function mergeKeyed<T extends object>(
  base: Map<string, T> | null,
  local: Map<string, T>,
  incoming: Map<string, T>,
  fields: readonly (keyof T & string)[],
  subjectOf: (item: T) => string,
  reported: PlanMirrorReport[],
): T[] {
  const keys = [...incoming.keys(), ...[...local.keys()].filter((k) => !incoming.has(k))];
  const out: T[] = [];
  const modified = (a: T, b: T): boolean => fields.some((f) => a[f] !== b[f]);
  for (const key of keys) {
    const l = local.get(key);
    const i = incoming.get(key);
    const b = base?.get(key);
    if (l && i) {
      if (!base) {
        out.push(i);
        continue;
      }
      const merged = { ...i };
      for (const f of fields) {
        const r = pick3(b?.[f], l[f], i[f]);
        merged[f] = r.value;
        if (r.contested) {
          reported.push({
            kind: 'local-wins',
            subject: subjectOf(l),
            field: f,
            local: l[f],
            incoming: i[f],
          });
        }
      }
      out.push(merged);
      continue;
    }
    const only = (l ?? i) as T;
    if (!base || !b) {
      out.push(only);
      continue;
    }
    if (modified(only, b)) {
      out.push(only);
      reported.push({
        kind: 'kept-modified',
        subject: subjectOf(only),
        deletedBy: l ? 'incoming' : 'local',
      });
    }
  }
  return out;
}

/**
 * Three-way merge of two plan mirrors over their common base. Pure: no database, no filesystem.
 *
 * With a base, a node field one side changed goes through; a title, body, kind, status or
 * taskable both sides changed differently is a conflict (the merged value is the incoming one),
 * while an ordinal, parent, edge field or code-link field they changed differently keeps local
 * and is reported. A node one side deleted is deleted unless the other side modified it or
 * something under it; then it stays (restored from incoming when local lacks it) with its
 * ancestors. Edges and code links merge as sets. With no base the merge only adds: incoming wins
 * every field and nothing is deleted.
 */
export function mergePlanMirror(input: PlanMirrorMergeInput): PlanMirrorMerge {
  const base = input.base ? readSide(input.base) : null;
  const local = readSide(input.local);
  const incoming = readSide(input.incoming);
  const conflicts: PlanMirrorConflict[] = [];
  const reported: PlanMirrorReport[] = [];
  const resurrected: string[] = [];

  const ids = [
    ...incoming.nodes.map((n) => n.id),
    ...local.nodes.map((n) => n.id).filter((id) => !incoming.byId.has(id)),
  ];
  const entries = new Map<string, Entry>();
  ids.forEach((id, rank) => {
    const l = local.byId.get(id);
    const i = incoming.byId.get(id);
    const b = base?.byId.get(id);
    if (l && i) {
      if (!base) {
        entries.set(id, {
          node: { ...i },
          rank,
          inLocal: true,
          parentFromIncoming: i.parentId !== l.parentId,
          candidate: null,
        });
        return;
      }
      const parent = pick3(b?.parentId, l.parentId, i.parentId);
      const ordinal = pick3(b?.ordinal, l.ordinal, i.ordinal);
      for (const [field, r, lv, iv] of [
        ['parentId', parent, l.parentId, i.parentId],
        ['ordinal', ordinal, l.ordinal, i.ordinal],
      ] as const) {
        if (r.contested) {
          reported.push({ kind: 'local-wins', subject: id, field, local: lv, incoming: iv });
        }
      }
      const node: MirrorNode = { ...l, parentId: parent.value, ordinal: ordinal.value };
      const fieldsOut = node as unknown as Record<string, unknown>;
      for (const field of PLAN_MIRROR_ASKED_FIELDS) {
        const r = pick3<unknown>(b?.[field], l[field], i[field]);
        fieldsOut[field] = r.contested ? i[field] : r.value;
        if (r.contested) {
          conflicts.push({
            nodeId: id,
            field,
            base: b?.[field],
            local: l[field],
            incoming: i[field],
          });
        }
      }
      entries.set(id, {
        node,
        rank,
        inLocal: true,
        parentFromIncoming: parent.value !== l.parentId,
        candidate: null,
      });
      return;
    }
    const only = (l ?? i) as MirrorNode;
    const entry: Entry = {
      node: { ...only },
      rank,
      inLocal: l !== undefined,
      parentFromIncoming: false,
      candidate: null,
    };
    if (base && b) {
      if (nodeModified(only, b)) {
        reported.push({
          kind: 'kept-modified',
          subject: id,
          deletedBy: l ? 'incoming' : 'local',
        });
        if (!l) resurrected.push(id);
      } else {
        entry.candidate = l ? 'deleted-by-incoming' : 'deleted-by-local';
      }
    }
    entries.set(id, entry);
  });

  for (let cycle = findCycle(entries); cycle; cycle = findCycle(entries)) {
    const members = cycle
      .map((id) => ({ id, entry: entries.get(id)! }))
      .filter((m) => m.entry.parentFromIncoming)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const pick = members[0];
    if (!pick) throw new Error('plan merge: the local plan has a parent cycle');
    const l = local.byId.get(pick.id)!;
    reported.push({
      kind: 'local-wins',
      subject: pick.id,
      field: 'parentId',
      local: l.parentId,
      incoming: pick.entry.node.parentId,
    });
    pick.entry.node.parentId = l.parentId;
    pick.entry.parentFromIncoming = false;
  }

  const walked = new Set<string>();
  for (const entry of [...entries.values()]) {
    if (entry.candidate) continue;
    let parentId = entry.node.parentId;
    while (parentId !== null && !walked.has(parentId)) {
      walked.add(parentId);
      const ancestor = entries.get(parentId);
      if (!ancestor) break;
      if (ancestor.candidate) {
        const deletedBy = ancestor.candidate === 'deleted-by-local' ? 'local' : 'incoming';
        reported.push({ kind: 'kept-ancestor', subject: parentId, deletedBy });
        if (deletedBy === 'local') resurrected.push(parentId);
        ancestor.candidate = null;
      }
      parentId = ancestor.node.parentId;
    }
  }

  const nodes = [...entries.values()]
    .filter((e) => e.candidate === null)
    .sort((a, b) => a.node.ordinal - b.node.ordinal || a.rank - b.rank)
    .map((e) => e.node);
  const liveIds = new Set(nodes.map((n) => n.id));

  const localDepth = (id: string): number => {
    let depth = 0;
    for (
      let p = local.byId.get(id)?.parentId ?? null;
      p !== null;
      p = local.byId.get(p)?.parentId ?? null
    )
      depth++;
    return depth;
  };
  const deleted = [...entries.entries()]
    .filter(([, e]) => e.candidate === 'deleted-by-incoming')
    .map(([id, e]) => ({ id, depth: localDepth(id), rank: e.rank }))
    .sort((a, b) => b.depth - a.depth || a.rank - b.rank)
    .map((d) => d.id);

  const edgeKey = (e: MirrorEdge): string => JSON.stringify([e.fromNodeId, e.toNodeId, e.kind]);
  const edgeMap = (s: Side | null): Map<string, MirrorEdge> | null =>
    s && new Map(s.edges.map((e) => [edgeKey(e), e]));
  const edges = mergeKeyed(
    edgeMap(base),
    edgeMap(local)!,
    edgeMap(incoming)!,
    ['note'],
    (e) => `edge:${e.fromNodeId}>${e.toNodeId}:${e.kind}`,
    reported,
  ).filter((e) => liveIds.has(e.fromNodeId) && liveIds.has(e.toNodeId));

  const linkKey = (l: MirrorCodeLink): string =>
    JSON.stringify([l.nodeId, l.repoPath, l.symbol ?? '']);
  const linkMap = (s: Side | null): Map<string, MirrorCodeLink> | null =>
    s && new Map(s.links.map((l) => [linkKey(l), l]));
  const codeLinks = mergeKeyed(
    linkMap(base),
    linkMap(local)!,
    linkMap(incoming)!,
    ['evidence', 'derivedAtCommit', 'stale', 'role'],
    (l) => `code-link:${l.nodeId}:${l.repoPath}:${l.symbol ?? ''}`,
    reported,
  ).filter((l) => liveIds.has(l.nodeId));

  return {
    merged: { schemaVersion: 2, nodes, edges, codeLinks },
    conflicts,
    deleted,
    resurrected,
    reported,
  };
}
