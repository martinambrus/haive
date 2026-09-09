import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDEBAR_TREE,
  NO_REPO_LABEL,
  addFolder,
  buildSidebarTree,
  collectCollapsibleKeys,
  deleteFolder,
  moveNode,
  normalizeSidebarTree,
  pruneTree,
  renameFolder,
  reorderNode,
  setClosedForKeys,
  siblingOrderAfterDrop,
  dropIntentFromY,
  ROOT_CONTAINER,
  type SidebarTaskLike,
  type SidebarTree,
} from './sidebar-tree';

function task(id: string, repo: string | null, type = 'workflow'): SidebarTaskLike {
  return {
    id,
    type,
    repository: repo ? { id: repo, name: repo } : null,
    repositoryId: repo,
  };
}

function tree(over: Partial<SidebarTree> = {}): SidebarTree {
  return { folders: [], placements: {}, closed: [], order: {}, ...over };
}

describe('buildSidebarTree — the default arrangement', () => {
  it('groups tasks by repository with nothing stored', () => {
    const nodes = buildSidebarTree([task('t1', 'haive'), task('t2', 'haive')], EMPTY_SIDEBAR_TREE);
    expect(nodes).toHaveLength(1);
    const group = nodes[0];
    expect(group).toMatchObject({ kind: 'repo', name: 'haive' });
    expect(group?.kind === 'repo' && group.tasks).toHaveLength(2);
  });

  it('orders repository groups by name', () => {
    const nodes = buildSidebarTree([task('t1', 'zulu'), task('t2', 'alpha')], EMPTY_SIDEBAR_TREE);
    expect(nodes.map((n) => (n.kind === 'repo' ? n.name : ''))).toEqual(['alpha', 'zulu']);
  });

  it('collects tasks with no repository under their own group', () => {
    const nodes = buildSidebarTree([task('t1', null)], EMPTY_SIDEBAR_TREE);
    expect(nodes[0]).toMatchObject({ kind: 'repo', name: NO_REPO_LABEL });
  });

  it('drops the hidden task types', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'haive', 'plan_build'), task('t2', 'haive', 'plan_chat')],
      EMPTY_SIDEBAR_TREE,
    );
    expect(nodes).toHaveLength(0);
  });
});

describe('buildSidebarTree — the stored arrangement', () => {
  const withFolder = tree({ folders: [{ id: 'f1', name: 'Frontend', parentId: null, order: 1 }] });

  it('files a whole repository group into a folder', () => {
    const nodes = buildSidebarTree([task('t1', 'haive')], {
      ...withFolder,
      placements: { 'repo:haive': 'f1' },
    });
    expect(nodes).toHaveLength(1);
    const folder = nodes[0];
    expect(folder).toMatchObject({ kind: 'folder', taskCount: 1 });
    expect(folder?.kind === 'folder' && folder.children[0]).toMatchObject({ kind: 'repo' });
  });

  it('files a single task into a folder, lifting it out of its repository group', () => {
    const nodes = buildSidebarTree([task('t1', 'haive'), task('t2', 'haive')], {
      ...withFolder,
      placements: { 'task:t1': 'f1' },
    });
    const folder = nodes.find((n) => n.kind === 'folder');
    const repo = nodes.find((n) => n.kind === 'repo');
    expect(folder).toMatchObject({ taskCount: 1 });
    expect(repo?.kind === 'repo' && repo.tasks.map((t) => t.task.id)).toEqual(['t2']);
  });

  it('nests folders', () => {
    const nodes = buildSidebarTree([task('t1', 'haive')], {
      folders: [
        { id: 'f1', name: 'Outer', parentId: null, order: 1 },
        { id: 'f2', name: 'Inner', parentId: 'f1', order: 1 },
      ],
      placements: { 'task:t1': 'f2' },
      closed: [],
    });
    expect(nodes).toHaveLength(1);
    const outer = nodes[0]!;
    expect(outer.kind === 'folder' && outer.taskCount).toBe(1);
    expect(outer.kind === 'folder' && outer.children[0]).toMatchObject({ kind: 'folder' });
  });

  // A folder deleted in another tab must not take the task with it.
  it('ignores a placement naming a folder that no longer exists', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'haive')],
      tree({ placements: { 'task:t1': 'gone' } }),
    );
    expect(nodes[0]).toMatchObject({ kind: 'repo', name: 'haive' });
  });

  it('terminates on a folder cycle rather than recursing forever', () => {
    const nodes = buildSidebarTree([task('t1', 'haive')], {
      folders: [
        { id: 'f1', name: 'A', parentId: 'f2', order: 1 },
        { id: 'f2', name: 'B', parentId: 'f1', order: 1 },
      ],
      placements: {},
      closed: [],
    });
    // Neither folder has a reachable root, so only the repo group renders.
    expect(nodes.filter((n) => n.kind === 'repo')).toHaveLength(1);
  });
});

describe('moveNode', () => {
  const base = tree({
    folders: [
      { id: 'f1', name: 'A', parentId: null, order: 1 },
      { id: 'f2', name: 'B', parentId: 'f1', order: 1 },
    ],
  });

  it('records a task placement', () => {
    expect(moveNode(base, 'task:t1', 'f1').placements).toEqual({ 'task:t1': 'f1' });
  });

  it('dropping on the root restores the default placement instead of storing "root"', () => {
    const filed = moveNode(base, 'task:t1', 'f1');
    expect(moveNode(filed, 'task:t1', null).placements).toEqual({});
  });

  it('re-parents a folder', () => {
    const moved = moveNode(base, 'f2', null);
    expect(moved.folders.find((f) => f.id === 'f2')!.parentId).toBeNull();
  });

  it('refuses a folder dropped into its own subtree', () => {
    expect(moveNode(base, 'f1', 'f2')).toBe(base);
  });

  it('refuses a folder dropped onto itself', () => {
    expect(moveNode(base, 'f1', 'f1')).toBe(base);
  });

  it('refuses an unknown target folder', () => {
    expect(moveNode(base, 'task:t1', 'nope')).toBe(base);
  });

  it('returns the same object for a no-op, so the caller can skip the write', () => {
    const filed = moveNode(base, 'task:t1', 'f1');
    expect(moveNode(filed, 'task:t1', 'f1')).toBe(filed);
  });
});

describe('folder edits', () => {
  it('adds and renames', () => {
    const added = addFolder(EMPTY_SIDEBAR_TREE, '  Frontend  ', null);
    expect(added.folders[0]).toMatchObject({ name: 'Frontend', parentId: null });
    expect(renameFolder(added, added.folders[0]!.id, 'Backend').folders[0]!.name).toBe('Backend');
  });

  it('ignores a blank name', () => {
    expect(addFolder(EMPTY_SIDEBAR_TREE, '   ', null)).toBe(EMPTY_SIDEBAR_TREE);
  });

  // Deleting a view of the work must never hide the work.
  it('re-parents children to the deleted folder parent', () => {
    const start = tree({
      folders: [
        { id: 'f1', name: 'Outer', parentId: null, order: 1 },
        { id: 'f2', name: 'Inner', parentId: 'f1', order: 1 },
      ],
      placements: { 'task:t1': 'f2' },
    });
    const after = deleteFolder(start, 'f2');
    expect(after.folders.map((f) => f.id)).toEqual(['f1']);
    expect(after.placements).toEqual({ 'task:t1': 'f1' });
  });

  it('restores the default placement when a top-level folder is deleted', () => {
    const start = tree({
      folders: [{ id: 'f1', name: 'A', parentId: null, order: 1 }],
      placements: { 'task:t1': 'f1' },
    });
    expect(deleteFolder(start, 'f1').placements).toEqual({});
  });
});

describe('pruneTree', () => {
  it('drops placements for tasks that are gone and keeps repo placements', () => {
    const start = tree({ placements: { 'task:t1': 'f1', 'task:t2': 'f1', 'repo:haive': 'f1' } });
    const after = pruneTree(start, ['t1']);
    expect(after.placements).toEqual({ 'task:t1': 'f1', 'repo:haive': 'f1' });
  });
});

describe('normalizeSidebarTree', () => {
  it('returns the empty tree for anything malformed', () => {
    expect(normalizeSidebarTree(null)).toEqual(EMPTY_SIDEBAR_TREE);
    expect(normalizeSidebarTree('nope')).toEqual(EMPTY_SIDEBAR_TREE);
    expect(normalizeSidebarTree([1, 2])).toEqual(EMPTY_SIDEBAR_TREE);
  });

  it('keeps the well-formed parts and discards the rest', () => {
    const out = normalizeSidebarTree({
      folders: [
        { id: 'f1', name: 'A', parentId: null, order: 1 },
        { id: 'f2', name: 'B' },
      ],
      placements: { 'task:t1': 'f1', 'task:t2': 7 },
      closed: ['f1', 3],
    });
    expect(out.folders.map((f) => f.id)).toEqual(['f1']);
    expect(out.placements).toEqual({ 'task:t1': 'f1' });
    expect(out.closed).toEqual(['f1']);
  });
});

describe('collectCollapsibleKeys', () => {
  const nested: SidebarTree = {
    folders: [
      { id: 'f1', name: 'Outer', parentId: null, order: 1 },
      { id: 'f2', name: 'Inner', parentId: 'f1', order: 1 },
    ],
    placements: { 'task:t1': 'f2', 'repo:beta': 'f1' },
    closed: [],
  };

  it('returns folders and repository groups, never tasks', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'alpha'), task('t2', 'beta'), task('t3', 'gamma')],
      nested,
    );
    expect(collectCollapsibleKeys(nodes).sort()).toEqual(['f1', 'f2', 'repo:beta', 'repo:gamma']);
  });

  // The point of "expand all": one click opens the whole depth, not one level per click.
  it('descends into folders that are currently closed', () => {
    const nodes = buildSidebarTree([task('t1', 'alpha')], { ...nested, closed: ['f1'] });
    expect(collectCollapsibleKeys(nodes)).toContain('f2');
  });
});

describe('setClosedForKeys', () => {
  const base = tree({ closed: ['a'] });

  it('closes every key given', () => {
    expect(setClosedForKeys(base, ['a', 'b', 'c'], true).closed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('opens every key given and leaves the rest alone', () => {
    const start = tree({ closed: ['a', 'b', 'z'] });
    expect(setClosedForKeys(start, ['a', 'b'], false).closed).toEqual(['z']);
  });

  it('returns the same object when nothing changes, so a repeat click costs no write', () => {
    expect(setClosedForKeys(base, ['a'], true)).toBe(base);
    expect(setClosedForKeys(base, ['b'], false)).toBe(base);
    expect(setClosedForKeys(base, [], true)).toBe(base);
  });
});

describe('dropIntentFromY', () => {
  it('splits a container three ways, with the middle band the widest', () => {
    expect(dropIntentFromY(2, 20, true)).toBe('before');
    expect(dropIntentFromY(10, 20, true)).toBe('into');
    expect(dropIntentFromY(18, 20, true)).toBe('after');
  });

  // "Inside a task" is not a place, so a non-container is a straight half-and-half.
  it('splits a non-container in half', () => {
    expect(dropIntentFromY(4, 20, false)).toBe('before');
    expect(dropIntentFromY(10, 20, false)).toBe('after');
    expect(dropIntentFromY(16, 20, false)).toBe('after');
  });

  it('does not divide by a zero height', () => {
    expect(dropIntentFromY(0, 0, true)).toBe('into');
    expect(dropIntentFromY(0, 0, false)).toBe('before');
  });
});

describe('siblingOrderAfterDrop', () => {
  const sibs = ['a', 'b', 'c'];

  it('moves a node before a later sibling', () => {
    expect(siblingOrderAfterDrop(sibs, 'a', 'c', 'before')).toEqual(['b', 'a', 'c']);
  });

  it('moves a node after a later sibling', () => {
    expect(siblingOrderAfterDrop(sibs, 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
  });

  // The dragged node is removed BEFORE the index is taken, or dropping it forward lands
  // one slot short of where the marker was drawn.
  it('accounts for its own removal when moving forward', () => {
    expect(siblingOrderAfterDrop(sibs, 'b', 'c', 'after')).toEqual(['a', 'c', 'b']);
  });

  it('brings a node in from another container', () => {
    expect(siblingOrderAfterDrop(['a', 'b', 'x'], 'x', 'a', 'before')).toEqual(['x', 'a', 'b']);
  });

  it('returns the input when the reference is not a sibling', () => {
    expect(siblingOrderAfterDrop(sibs, 'a', 'zz', 'before')).toBe(sibs);
  });
});

describe('reorderNode', () => {
  it('stamps a position on every sibling, not only the moved one', () => {
    const out = reorderNode(tree(), 'b', ROOT_CONTAINER, ['b', 'a', 'c']);
    expect(out.order).toEqual({ b: 0, a: 1, c: 2 });
  });

  it('re-parents while positioning, for a node arriving from elsewhere', () => {
    const start = tree({ folders: [{ id: 'f1', name: 'A', parentId: null, order: 1 }] });
    const out = reorderNode(start, 'task:t1', 'f1', ['task:t1', 'task:t2']);
    expect(out.placements['task:t1']).toBe('f1');
    expect(out.order?.['task:t1']).toBe(0);
  });

  // Dragging a filed task back among its own repository's tasks means "un-file me".
  it('un-files a task dropped back into its repo group', () => {
    const start = tree({
      folders: [{ id: 'f1', name: 'A', parentId: null, order: 1 }],
      placements: { 'task:t1': 'f1' },
    });
    const out = reorderNode(start, 'task:t1', 'repo:r1', ['task:t2', 'task:t1']);
    expect(out.placements['task:t1']).toBeUndefined();
    expect(out.order).toEqual({ 'task:t2': 0, 'task:t1': 1 });
  });

  it('refuses a folder positioned inside its own subtree', () => {
    const start = tree({
      folders: [
        { id: 'f1', name: 'A', parentId: null, order: 1 },
        { id: 'f2', name: 'B', parentId: 'f1', order: 1 },
      ],
    });
    expect(reorderNode(start, 'f1', 'f2', ['f1'])).toBe(start);
  });

  it('refuses when the dragged key is not among the siblings given', () => {
    const t = tree();
    expect(reorderNode(t, 'x', ROOT_CONTAINER, ['a', 'b'])).toBe(t);
  });
});

describe('buildSidebarTree — explicit order', () => {
  it('honours a stored position over the default name sort', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'alpha'), task('t2', 'zulu')],
      tree({ order: { 'repo:zulu': 0, 'repo:alpha': 1 } }),
    );
    expect(nodes.map((n) => (n.kind === 'repo' ? n.name : ''))).toEqual(['zulu', 'alpha']);
  });

  // A task that appears while a list is hand-sorted must not land in the middle of it.
  it('puts unpositioned nodes after the positioned ones', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'alpha'), task('t2', 'mike'), task('t3', 'zulu')],
      tree({ order: { 'repo:zulu': 0 } }),
    );
    expect(nodes.map((n) => (n.kind === 'repo' ? n.name : ''))).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('orders tasks inside a repository group', () => {
    const nodes = buildSidebarTree(
      [task('t1', 'alpha'), task('t2', 'alpha')],
      tree({ order: { 'task:t2': 0, 'task:t1': 1 } }),
    );
    const group = nodes[0];
    expect(group?.kind === 'repo' && group.tasks.map((t) => t.task.id)).toEqual(['t2', 't1']);
  });
});

describe('pruneTree — order entries', () => {
  it('drops positions for tasks that are gone, keeping folder and repo ones', () => {
    const start = tree({ order: { 'task:t1': 0, 'task:t2': 1, 'repo:r': 2, f1: 3 } });
    expect(pruneTree(start, ['t1']).order).toEqual({ 'task:t1': 0, 'repo:r': 2, f1: 3 });
  });
});
