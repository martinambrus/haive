/**
 * The sidebar's active-task tree: what it contains by default, and how the user's own
 * folder arrangement is layered over that.
 *
 * Pure — no React, no fetch — so every placement rule below is unit-testable.
 *
 * The default arrangement is DERIVED, never stored: one group per repository that has
 * active tasks, with that repository's tasks inside it. Only a MOVE is persisted. That is
 * what keeps the blob small (it rides `user_ui_prefs`, capped at 64 KiB) and what lets a
 * task the user never touched appear in the right place the moment it is created.
 */

/** A task's own key. Prefixed so one map can hold both kinds of placement. */
export type NodeKey = `task:${string}` | `repo:${string}`;

export interface SidebarFolder {
  id: string;
  name: string;
  /** null = a top-level folder. */
  parentId: string | null;
  order: number;
}

export interface SidebarTree {
  folders: SidebarFolder[];
  /** Where the user MOVED something. An absent key means the default placement, so a
   *  task nobody has filed costs nothing to store. */
  placements: Record<string, string>;
  /** Folder and repo-group keys the user closed. Closed rather than open, so a new
   *  repository arrives expanded. */
  closed: string[];
  /** Explicit position within a container, by node key. Sparse: a node with no entry keeps
   *  its default position and sorts AFTER everything positioned by hand, so a task that
   *  appears while a list is hand-sorted lands at the bottom instead of in the middle. */
  order?: Record<string, number>;
}

export const EMPTY_SIDEBAR_TREE: SidebarTree = {
  folders: [],
  placements: {},
  closed: [],
  order: {},
};

/** Task types the sidebar never lists.
 *
 *  `plan_chat` and `plan_merge` are already dropped server-side by GET /tasks unless
 *  `includeChats` is passed, so this only has to remove `plan_build` in practice —
 *  it names `plan_chat` anyway because relying on the absence of a query parameter to
 *  enforce a product rule puts the rule somewhere nobody reading this file can see. */
export const SIDEBAR_HIDDEN_TYPES: ReadonlySet<string> = new Set(['plan_chat', 'plan_build']);

/** The group a task with no repository falls into. A real key, so it can be filed like
 *  any other group. */
export const NO_REPO_KEY = 'repo:none';
export const NO_REPO_LABEL = 'No repository';

/** Minimal shape this module needs from a task row — deliberately not `Task`, so the
 *  tests do not have to build 80-field fixtures. */
export interface SidebarTaskLike {
  id: string;
  type: string;
  repository?: { id: string; name: string } | null;
  repositoryId?: string | null;
}

export function taskKey(id: string): NodeKey {
  return `task:${id}`;
}

export function repoKey(repositoryId: string | null | undefined): NodeKey {
  return repositoryId ? `repo:${repositoryId}` : (NO_REPO_KEY as NodeKey);
}

export interface RenderedTask<T> {
  kind: 'task';
  key: NodeKey;
  task: T;
}

export interface RenderedRepo<T> {
  kind: 'repo';
  key: NodeKey;
  name: string;
  tasks: RenderedTask<T>[];
}

export interface RenderedFolder<T> {
  kind: 'folder';
  key: string;
  folder: SidebarFolder;
  children: RenderedNode<T>[];
  /** Tasks and repo groups counted through the whole subtree, for the collapsed label. */
  taskCount: number;
}

export type RenderedNode<T> = RenderedFolder<T> | RenderedRepo<T> | RenderedTask<T>;

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/** What a node is positioned WITHIN. '' is the root; otherwise a folder id, or a repo
 *  group's own key. Repo groups are derived rather than stored, so they can hold an order
 *  without ever being something the user files into. */
export const ROOT_CONTAINER = '';

export function isRepoContainer(container: string): boolean {
  return container.startsWith('repo:');
}

/** The key a node is ordered by — the same string used as its `order` and `placements` key. */
export function orderKey<T>(node: RenderedNode<T>): string {
  return node.kind === 'folder' ? node.folder.id : node.key;
}

/** Impose the stored order on one level.
 *
 *  Stable, and unpositioned nodes score Infinity, so they keep the default arrangement
 *  among themselves and follow the hand-placed ones. `Infinity - Infinity` is NaN, which a
 *  comparator must never return, hence the equality branch. */
function applyOrder<T>(nodes: RenderedNode<T>[], order: Record<string, number>): RenderedNode<T>[] {
  if (nodes.length < 2) return nodes;
  return [...nodes].sort((a, b) => {
    const oa = order[orderKey(a)] ?? Number.POSITIVE_INFINITY;
    const ob = order[orderKey(b)] ?? Number.POSITIVE_INFINITY;
    return oa === ob ? 0 : oa - ob;
  });
}

/**
 * Fold the fetched tasks and the stored arrangement into what the sidebar renders.
 *
 * Order of resolution for one task:
 *   1. an explicit `task:<id>` placement wins — it sits directly in that folder;
 *   2. otherwise it sits in its repository's group;
 *   3. that group sits in its `repo:<id>` placement's folder, or at the root.
 *
 * A placement naming a folder that no longer exists is IGNORED rather than repaired, so a
 * folder deleted in another tab degrades to the default position instead of vanishing.
 */
export function buildSidebarTree<T extends SidebarTaskLike>(
  tasks: T[],
  tree: SidebarTree,
): RenderedNode<T>[] {
  const visible = tasks.filter((t) => !SIDEBAR_HIDDEN_TYPES.has(t.type));
  const folderIds = new Set(tree.folders.map((f) => f.id));
  const placedIn = (key: string): string | null => {
    const id = tree.placements[key];
    return id && folderIds.has(id) ? id : null;
  };

  // Tasks filed on their own, and tasks left in their repository group.
  const loose = new Map<string, RenderedTask<T>[]>();
  const repoGroups = new Map<string, RenderedRepo<T>>();

  for (const task of visible) {
    const node: RenderedTask<T> = { kind: 'task', key: taskKey(task.id), task };
    const ownFolder = placedIn(node.key);
    if (ownFolder) {
      const list = loose.get(ownFolder) ?? [];
      list.push(node);
      loose.set(ownFolder, list);
      continue;
    }
    const key = repoKey(task.repository?.id ?? task.repositoryId ?? null);
    let group = repoGroups.get(key);
    if (!group) {
      group = { kind: 'repo', key, name: task.repository?.name ?? NO_REPO_LABEL, tasks: [] };
      repoGroups.set(key, group);
    }
    group.tasks.push(node);
  }

  // Folders, then the repo groups and loose tasks that hang off each.
  const foldersByParent = new Map<string | null, SidebarFolder[]>();
  for (const folder of tree.folders) {
    const parent = folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null;
    const list = foldersByParent.get(parent) ?? [];
    list.push(folder);
    foldersByParent.set(parent, list);
  }

  const reposByFolder = new Map<string | null, RenderedRepo<T>[]>();
  for (const group of repoGroups.values()) {
    const parent = placedIn(group.key);
    const list = reposByFolder.get(parent) ?? [];
    list.push(group);
    reposByFolder.set(parent, list);
  }

  // Guards against a cycle the model should not be able to hold, but a hand-edited or
  // half-written blob can: without it this recursion does not terminate.
  const seen = new Set<string>();

  const order = tree.order ?? {};

  const renderFolder = (folder: SidebarFolder): RenderedFolder<T> => {
    seen.add(folder.id);
    const children = applyOrder<T>(
      [
        ...(foldersByParent.get(folder.id) ?? [])
          .filter((f) => !seen.has(f.id))
          .sort((a, b) => a.order - b.order || byName(a, b))
          .map(renderFolder),
        ...(reposByFolder.get(folder.id) ?? []).sort(byName),
        ...(loose.get(folder.id) ?? []),
      ],
      order,
    );
    return {
      kind: 'folder',
      key: folder.id,
      folder,
      children,
      taskCount: countTasks(children),
    };
  };

  // Tasks inside a repo group are orderable too, and that group is their container.
  for (const group of repoGroups.values()) {
    group.tasks = applyOrder<T>(group.tasks, order) as RenderedTask<T>[];
  }

  return applyOrder<T>(
    [
      ...(foldersByParent.get(null) ?? [])
        .sort((a, b) => a.order - b.order || byName(a, b))
        .map(renderFolder),
      ...(reposByFolder.get(null) ?? []).sort(byName),
    ],
    order,
  );
}

export function countTasks<T>(nodes: RenderedNode<T>[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'task') n += 1;
    else if (node.kind === 'repo') n += node.tasks.length;
    else n += node.taskCount;
  }
  return n;
}

/** True when `folderId` is `candidate` or sits underneath it. */
function isDescendant(folders: SidebarFolder[], folderId: string, candidate: string): boolean {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  let cursor: string | null | undefined = folderId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === candidate) return true;
    if (seen.has(cursor)) return false; // a cycle in stored data, not a descendant
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

/**
 * Move a task, a repository group, or a folder into `targetFolderId` (null = the root).
 *
 * Returns the SAME tree object when the move is refused or is a no-op, so a caller can
 * skip the write on identity.
 */
export function moveNode(
  tree: SidebarTree,
  dragKey: string,
  targetFolderId: string | null,
): SidebarTree {
  if (targetFolderId !== null && !tree.folders.some((f) => f.id === targetFolderId)) return tree;

  // A folder being re-parented.
  const dragged = tree.folders.find((f) => f.id === dragKey);
  if (dragged) {
    if (dragged.parentId === targetFolderId) return tree;
    // Into itself or its own subtree would detach the branch from the root entirely.
    if (targetFolderId !== null && isDescendant(tree.folders, targetFolderId, dragged.id)) {
      return tree;
    }
    return {
      ...tree,
      folders: tree.folders.map((f) =>
        f.id === dragged.id ? { ...f, parentId: targetFolderId } : f,
      ),
    };
  }

  const current = tree.placements[dragKey] ?? null;
  if (current === targetFolderId) return tree;
  const placements = { ...tree.placements };
  // Dropping on the root RESTORES the default placement rather than recording "root",
  // so a task filed there follows its repository group again.
  if (targetFolderId === null) delete placements[dragKey];
  else placements[dragKey] = targetFolderId;
  return { ...tree, placements };
}

/** Where a drop lands relative to the row under the pointer. */
export type DropIntent = 'before' | 'into' | 'after';

/**
 * Resolve a drop intent from the pointer's position inside a row.
 *
 * Containers get a middle band that means "put it inside"; everything else splits in half,
 * because "inside a task" is not a place. The bands are deliberately uneven — 25/50/25 —
 * since filing into a folder is the commoner gesture and the row is only ~21px tall.
 */
export function dropIntentFromY(offsetY: number, height: number, allowInto: boolean): DropIntent {
  if (height <= 0) return allowInto ? 'into' : 'before';
  const y = offsetY / height;
  if (!allowInto) return y < 0.5 ? 'before' : 'after';
  if (y < 0.25) return 'before';
  if (y > 0.75) return 'after';
  return 'into';
}

/** The sibling order that results from moving `dragKey` before/after `refKey`. */
export function siblingOrderAfterDrop(
  siblings: string[],
  dragKey: string,
  refKey: string,
  intent: 'before' | 'after',
): string[] {
  const without = siblings.filter((k) => k !== dragKey);
  const at = without.indexOf(refKey);
  if (at === -1) return siblings;
  const insert = intent === 'before' ? at : at + 1;
  return [...without.slice(0, insert), dragKey, ...without.slice(insert)];
}

/**
 * Place `dragKey` among `siblingKeys` inside `container`, moving it there if it is arriving
 * from somewhere else.
 *
 * Stamps an explicit position on EVERY sibling rather than only the moved one. A single
 * value would have to sit between its neighbours', which needs either fractions that lose
 * precision after enough drops or a renumber pass anyway — and a container holds few
 * children, so rewriting the level is the cheaper answer as well as the exact one.
 */
export function reorderNode(
  tree: SidebarTree,
  dragKey: string,
  container: string,
  siblingKeys: string[],
): SidebarTree {
  if (!siblingKeys.includes(dragKey)) return tree;
  let next = tree;

  if (isRepoContainer(container)) {
    // A repo group is derived from the tasks themselves, so it is not something to file
    // INTO — but a task that was filed into a folder and then dragged back among its own
    // repository's tasks is asking to be un-filed, and that is the only containment change
    // this branch can mean.
    if (tree.placements[dragKey] !== undefined) {
      const placements = { ...tree.placements };
      delete placements[dragKey];
      next = { ...tree, placements };
    }
  } else {
    const parentId = container === ROOT_CONTAINER ? null : container;
    if (parentId !== null && !tree.folders.some((f) => f.id === parentId)) return tree;
    const dragged = tree.folders.find((f) => f.id === dragKey);
    // Same refusal as moveNode: a folder dropped inside its own subtree detaches the branch.
    if (dragged && parentId !== null && isDescendant(tree.folders, parentId, dragged.id)) {
      return tree;
    }
    next = moveNode(tree, dragKey, parentId);
  }

  const order = { ...(next.order ?? {}) };
  siblingKeys.forEach((key, i) => {
    order[key] = i;
  });
  return { ...next, order };
}

let folderSeq = 0;

/** A folder id that does not depend on `crypto.randomUUID`, which is absent on
 *  non-secure origins — this ships to whatever host the install runs on. */
export function newFolderId(): string {
  folderSeq += 1;
  return `f${Date.now().toString(36)}${folderSeq.toString(36)}`;
}

export function addFolder(tree: SidebarTree, name: string, parentId: string | null): SidebarTree {
  const trimmed = name.trim();
  if (!trimmed) return tree;
  const order = tree.folders.reduce((max, f) => Math.max(max, f.order), 0) + 1;
  return {
    ...tree,
    folders: [...tree.folders, { id: newFolderId(), name: trimmed, parentId, order }],
  };
}

export function renameFolder(tree: SidebarTree, id: string, name: string): SidebarTree {
  const trimmed = name.trim();
  if (!trimmed) return tree;
  return { ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) };
}

/**
 * Delete a folder, re-parenting whatever was inside it to the folder's own parent.
 *
 * It never removes a task: the tasks are the product's state, the folders are only a view
 * of them, so deleting a folder must not be able to hide work.
 */
export function deleteFolder(tree: SidebarTree, id: string): SidebarTree {
  const target = tree.folders.find((f) => f.id === id);
  if (!target) return tree;
  const parentId = target.parentId;
  const placements: Record<string, string> = {};
  for (const [key, folderId] of Object.entries(tree.placements)) {
    if (folderId !== id) placements[key] = folderId;
    else if (parentId !== null) placements[key] = parentId;
    // else: drop the entry, which restores the default placement.
  }
  const order = { ...(tree.order ?? {}) };
  delete order[id];
  return {
    folders: tree.folders
      .filter((f) => f.id !== id)
      .map((f) => (f.parentId === id ? { ...f, parentId } : f)),
    placements,
    closed: tree.closed.filter((k) => k !== id),
    order,
  };
}

/**
 * Every key in the rendered tree that can be opened or closed — custom folders and
 * repository groups alike.
 *
 * Walks the BUILT nodes rather than `tree.folders`, so it sees repository groups (which
 * are derived and exist in no stored list) and respects whatever the current filter left
 * on screen. It descends into CLOSED folders too: `buildSidebarTree` always populates
 * `children`, and only the renderer skips them — so "expand all" opens the whole depth in
 * one click instead of one level per click.
 */
export function collectCollapsibleKeys<T>(nodes: RenderedNode<T>[]): string[] {
  const keys: string[] = [];
  const walk = (list: RenderedNode<T>[]): void => {
    for (const node of list) {
      if (node.kind === 'task') continue;
      keys.push(node.kind === 'folder' ? node.folder.id : node.key);
      if (node.kind === 'folder') walk(node.children);
    }
  };
  walk(nodes);
  return keys;
}

/** Open or close `keys` all at once. Returns the SAME tree when nothing changes, so the
 *  caller can skip the write — clicking "collapse all" twice must not cost two requests. */
export function setClosedForKeys(tree: SidebarTree, keys: string[], closed: boolean): SidebarTree {
  if (keys.length === 0) return tree;
  if (closed) {
    const next = new Set([...tree.closed, ...keys]);
    if (next.size === tree.closed.length) return tree;
    return { ...tree, closed: [...next] };
  }
  const drop = new Set(keys);
  const next = tree.closed.filter((k) => !drop.has(k));
  if (next.length === tree.closed.length) return tree;
  return { ...tree, closed: next };
}

export function toggleClosed(tree: SidebarTree, key: string): SidebarTree {
  const closed = tree.closed.includes(key)
    ? tree.closed.filter((k) => k !== key)
    : [...tree.closed, key];
  return { ...tree, closed };
}

/**
 * Drop `task:` placements whose task is no longer in the list.
 *
 * Called only when the user has just made a change, NEVER on load: a fetch that failed or
 * returned a short page is indistinguishable from those tasks having finished, and this
 * would silently discard the user's filing. Repo placements are kept whatever happens —
 * a repository with no active tasks today will have some tomorrow.
 */
export function pruneTree(tree: SidebarTree, liveTaskIds: Iterable<string>): SidebarTree {
  const live = new Set<string>();
  for (const id of liveTaskIds) live.add(taskKey(id));
  const placements: Record<string, string> = {};
  for (const [key, folderId] of Object.entries(tree.placements)) {
    if (key.startsWith('task:') && !live.has(key)) continue;
    placements[key] = folderId;
  }
  const order: Record<string, number> = {};
  for (const [key, position] of Object.entries(tree.order ?? {})) {
    if (key.startsWith('task:') && !live.has(key)) continue;
    order[key] = position;
  }
  return { ...tree, placements, order };
}

/** Read a stored tree, discarding anything malformed.
 *
 *  Same rule as `readSplitState`: a half-applied arrangement is worse than the default,
 *  because the user cannot tell which half they are looking at. */
export function normalizeSidebarTree(raw: unknown): SidebarTree {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_SIDEBAR_TREE;
  const value = raw as Partial<SidebarTree>;
  const folders = Array.isArray(value.folders)
    ? value.folders.filter(
        (f): f is SidebarFolder =>
          !!f &&
          typeof f === 'object' &&
          typeof (f as SidebarFolder).id === 'string' &&
          typeof (f as SidebarFolder).name === 'string' &&
          typeof (f as SidebarFolder).order === 'number' &&
          ((f as SidebarFolder).parentId === null ||
            typeof (f as SidebarFolder).parentId === 'string'),
      )
    : [];
  const placements: Record<string, string> = {};
  if (
    value.placements &&
    typeof value.placements === 'object' &&
    !Array.isArray(value.placements)
  ) {
    for (const [key, folderId] of Object.entries(value.placements)) {
      if (typeof folderId === 'string') placements[key] = folderId;
    }
  }
  const closed = Array.isArray(value.closed)
    ? value.closed.filter((k): k is string => typeof k === 'string')
    : [];
  const order: Record<string, number> = {};
  if (value.order && typeof value.order === 'object' && !Array.isArray(value.order)) {
    for (const [key, position] of Object.entries(value.order)) {
      if (typeof position === 'number' && Number.isFinite(position)) order[key] = position;
    }
  }
  return { folders, placements, closed, order };
}
