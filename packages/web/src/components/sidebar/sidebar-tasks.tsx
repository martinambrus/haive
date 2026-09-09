'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Minus,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { api, type Task } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format-duration';
import { formatTokens } from '@/lib/format-tokens';
import { rememberTaskOrigin } from '@/lib/task-origin';
import {
  TASK_TONE_BUTTON_CLASS,
  TASK_TONE_CLASS,
  TASK_TONE_FILTERS,
  TASK_TONE_LABEL,
  filterTasksByTone,
  taskTone,
  type TaskToneFilter,
} from '@/lib/task-tone';
import {
  addFolder,
  buildSidebarTree,
  collectCollapsibleKeys,
  deleteFolder,
  moveNode,
  pruneTree,
  renameFolder,
  setClosedForKeys,
  toggleClosed,
  type RenderedNode,
  type SidebarTree,
} from '@/lib/sidebar-tree';

/** `unfinished` is the shared status token (@haive/shared expandTaskStatusFilter): open plus
 *  failed — "everything still needing attention". Named rather than spelled out so this and
 *  the tasks page's own filter dropdown cannot drift apart. */
const FEED_URL = '/tasks?status=unfinished&pageSize=100';

/** The ambient rate, matching the notification poller. The tasks page's 3s is for the
 *  surface you are looking at; this one is peripheral. The component is UNMOUNTED while the
 *  sidebar is collapsed, so a collapsed rail issues no request at all. */
const POLL_MS = 5_000;

interface SidebarTasksProps {
  tree: SidebarTree;
  onTreeChange: (next: SidebarTree) => void;
  /** Task states the list is narrowed to. Empty = no filter. */
  filters: TaskToneFilter[];
  onToggleFilter: (tone: TaskToneFilter) => void;
  /** What the back link on an opened task should say, or null to leave the default. */
  originLabel: string | null;
}

export function SidebarTasks({
  tree,
  onTreeChange,
  filters,
  onToggleFilter,
  originLabel,
}: SidebarTasksProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /** Ids from the last fetch that returned EVERY unfinished task, which is the only
   *  evidence that a task missing from it has actually gone. Null otherwise — a failed
   *  poll, or a page the server capped, would otherwise read as "those tasks finished"
   *  and prune the user's filing for work that is still running. */
  const liveIds = useRef<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<{ tasks: Task[]; total?: number }>(FEED_URL);
        if (cancelled) return;
        const complete = typeof data.total !== 'number' || data.tasks.length >= data.total;
        liveIds.current = complete ? data.tasks.map((t) => t.id) : null;
        setTasks(data.tasks);
        setError(false);
      } catch {
        if (cancelled) return;
        // Keep the last good list on screen; a poll that failed is not an empty workbench.
        setError(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const commit = useCallback(
    (next: SidebarTree) => {
      const ids = liveIds.current;
      onTreeChange(ids ? pruneTree(next, ids) : next);
    },
    [onTreeChange],
  );

  const onDrop = useCallback(
    (e: DragEvent, target: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      const key = e.dataTransfer.getData('text/plain');
      if (!key) return;
      const next = moveNode(tree, key, target);
      if (next === tree) return;
      commit(next);
    },
    [commit, tree],
  );

  const dropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(target ?? '');
    },
    onDragLeave: () => setDragOver((k) => (k === (target ?? '') ? null : k)),
    onDrop: (e: DragEvent) => onDrop(e, target),
  });

  const dragProps = (key: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', key);
      e.dataTransfer.effectAllowed = 'move';
    },
  });

  const renderNode = (node: RenderedNode<Task>, depth: number) => {
    const pad = { paddingLeft: 4 + depth * 10 };

    if (node.kind === 'task') {
      const task = node.task;
      const tone = taskTone(task);
      const effort = (task.timing?.workMs ?? 0) + (task.timing?.userActiveMs ?? 0);
      const tokens = task.tokenUsage?.totalTokens ?? 0;
      const meta = [
        effort > 0 ? formatDuration(effort) : null,
        tokens > 0 ? formatTokens(tokens) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        <Link
          key={node.key}
          href={`/tasks/${task.id}`}
          onClick={() => {
            if (!originLabel) return;
            rememberTaskOrigin(`/tasks/${task.id}`, {
              href: `${window.location.pathname}${window.location.search}`,
              label: originLabel,
            });
          }}
          {...dragProps(node.key)}
          style={pad}
          title={`${task.title} — ${TASK_TONE_LABEL[tone]}`}
          className={cn(
            'block cursor-grab rounded px-1.5 py-1 transition-colors active:cursor-grabbing',
            TASK_TONE_CLASS[tone],
          )}
        >
          <div className="truncate text-xs text-neutral-200">{task.title}</div>
          {meta && <div className="truncate text-[10px] text-neutral-500">{meta}</div>}
        </Link>
      );
    }

    if (node.kind === 'repo') {
      const closed = tree.closed.includes(node.key);
      return (
        <div key={node.key}>
          <button
            type="button"
            onClick={() => onTreeChange(toggleClosed(tree, node.key))}
            {...dragProps(node.key)}
            style={pad}
            title={node.name}
            className="flex w-full cursor-grab items-center gap-1 rounded py-1 pr-1 text-left text-xs text-neutral-400 transition-colors hover:bg-neutral-800/60 hover:text-neutral-200 active:cursor-grabbing"
          >
            {closed ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
              {node.tasks.length}
            </span>
          </button>
          {!closed && <div>{node.tasks.map((t) => renderNode(t, depth + 1))}</div>}
        </div>
      );
    }

    const closed = tree.closed.includes(node.key);
    // Captured rather than tested inline: a `renaming?.id === x` boolean does not narrow
    // `renaming` inside the callbacks below.
    const renameValue = renaming?.id === node.folder.id ? renaming.value : null;
    return (
      <div
        key={node.key}
        {...dropProps(node.folder.id)}
        className={cn(
          'rounded',
          dragOver === node.folder.id && 'bg-indigo-500/20 ring-1 ring-indigo-500',
        )}
      >
        <div
          style={pad}
          className="group/folder flex items-center gap-1 rounded py-1 pr-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-800/60"
        >
          <button
            type="button"
            onClick={() => onTreeChange(toggleClosed(tree, node.key))}
            {...dragProps(node.folder.id)}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-1 text-left active:cursor-grabbing"
            title={node.folder.name}
          >
            {closed ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            {closed ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            )}
            {renameValue !== null ? (
              <input
                autoFocus
                value={renameValue}
                onClick={(e) => e.preventDefault()}
                onChange={(e) => setRenaming({ id: node.folder.id, value: e.target.value })}
                onBlur={() => {
                  commit(renameFolder(tree, node.folder.id, renameValue));
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 text-xs text-neutral-100 outline-none focus:border-indigo-500"
              />
            ) : (
              <span className="truncate">{node.folder.name}</span>
            )}
            {renameValue === null && (
              <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                {node.taskCount}
              </span>
            )}
          </button>
          {renameValue === null && (
            <span className="hidden shrink-0 items-center gap-0.5 group-hover/folder:flex">
              <button
                type="button"
                aria-label={`Rename ${node.folder.name}`}
                title="Rename"
                onClick={() => setRenaming({ id: node.folder.id, value: node.folder.name })}
                className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${node.folder.name}`}
                // Nothing is lost by deleting a folder — its contents move up to where the
                // folder was — so this needs no confirmation.
                title="Delete folder (its tasks move up a level)"
                onClick={() => commit(deleteFolder(tree, node.folder.id))}
                className="rounded p-0.5 text-neutral-500 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
        {!closed && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  // The filter narrows the TASKS, not the rendered tree, so repository groups left with
  // nothing simply stop being derived. Custom folders still render (at count 0): they are
  // durable objects and the drop targets a drag needs, and hiding them would make filing
  // impossible for as long as a filter is on.
  const nodes = tasks ? buildSidebarTree(filterTasksByTone(tasks, filters), tree) : [];
  const collapsible = collectCollapsibleKeys(nodes);
  const filtering = filters.length > 0;

  const setAll = (closed: boolean) => {
    const next = setClosedForKeys(tree, collapsible, closed);
    if (next !== tree) onTreeChange(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        <span>Active tasks</span>
        {error && (
          <span className="text-amber-500" title="The last refresh failed; showing the last result">
            !
          </span>
        )}
        <button
          type="button"
          aria-label="Expand all folders"
          title="Expand all folders"
          onClick={() => setAll(false)}
          className="ml-auto rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          onClick={() => setAll(true)}
          className="rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            const next = addFolder(tree, 'New folder', null);
            commit(next);
            const created = next.folders[next.folders.length - 1];
            if (created) setRenaming({ id: created.id, value: created.name });
          }}
          className="rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Toggles, not a radio group: they combine, and turning the last one off returns the
          list to everything. `flex-1` each so all three fit at the 200px minimum width.
          Spacing lives on this row rather than as padding on the neighbours — it is what
          needs the air — and a flex column does not collapse margins, so both gaps are
          exactly what is written. Asymmetric on purpose: 10px up to the header, which this
          row belongs WITH, and 20px down to the list, which it acts ON. */}
      <div className="mb-5 mt-2.5 flex gap-1 px-1">
        {TASK_TONE_FILTERS.map((tone) => {
          const on = filters.includes(tone);
          return (
            <button
              key={tone}
              type="button"
              aria-pressed={on}
              title={
                on
                  ? `Showing ${tone} tasks — click to stop filtering by this`
                  : `Show only ${tone} tasks`
              }
              onClick={() => onToggleFilter(tone)}
              className={cn(
                'flex-1 rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
                on ? TASK_TONE_BUTTON_CLASS[tone].on : TASK_TONE_BUTTON_CLASS[tone].off,
              )}
            >
              {tone}
            </button>
          );
        })}
      </div>
      {/* The root is itself a drop target: dropping here un-files a task back to its
          repository group, which is otherwise unreachable once it has been moved. */}
      <div
        {...dropProps(null)}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto rounded pb-2',
          dragOver === '' && 'bg-indigo-500/10 ring-1 ring-indigo-500/60',
        )}
      >
        {tasks === null ? (
          <p className="px-1.5 py-2 text-xs text-neutral-600">Loading…</p>
        ) : nodes.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-neutral-600">
            {filtering ? 'No tasks match the filter' : 'No active tasks'}
          </p>
        ) : (
          nodes.map((n) => renderNode(n, 0))
        )}
      </div>
    </div>
  );
}
