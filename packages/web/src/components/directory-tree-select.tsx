'use client';

import { useCallback, useMemo, useState } from 'react';
import type { TreeNode } from '@haive/shared';
import { cn } from '@/lib/cn';

const BADGE_COLORS: Record<string, string> = {
  default: 'bg-neutral-800 text-neutral-300',
  amber: 'bg-amber-900/60 text-amber-300',
  indigo: 'bg-indigo-900/60 text-indigo-300',
  green: 'bg-green-900/60 text-green-300',
};

interface DirectoryTreeSelectProps {
  tree: TreeNode[];
  value: string[];
  onChange: (paths: string[]) => void;
  disabled?: boolean;
}

/** Collect ALL paths in a subtree (node + all descendants). */
function collectAllPaths(node: TreeNode): string[] {
  const paths = [node.path];
  if (node.children?.length) {
    for (const child of node.children) {
      paths.push(...collectAllPaths(child));
    }
  }
  return paths;
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

/** Compute check state for a node given the selected set. */
function getCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (!node.children?.length) {
    return selected.has(node.path) ? 'checked' : 'unchecked';
  }
  const childStates = node.children.map((c) => getCheckState(c, selected));
  if (childStates.every((s) => s === 'checked')) return 'checked';
  if (childStates.every((s) => s === 'unchecked')) return 'unchecked';
  return 'indeterminate';
}

export function DirectoryTreeSelect({
  tree,
  value,
  onChange,
  disabled = false,
}: DirectoryTreeSelectProps) {
  const selected = useMemo(() => new Set(value), [value]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand top-level nodes only
    const initial = new Set<string>();
    for (const node of tree) {
      if (node.children?.length) initial.add(node.path);
    }
    return initial;
  });

  const toggle = useCallback(
    (node: TreeNode) => {
      if (disabled) return;
      const allPaths = collectAllPaths(node);
      const state = getCheckState(node, selected);
      const next = new Set(selected);
      if (state === 'checked') {
        // Uncheck all
        for (const p of allPaths) next.delete(p);
      } else {
        // Check all
        for (const p of allPaths) next.add(p);
      }
      onChange([...next]);
    },
    [selected, onChange, disabled],
  );

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectedCount = value.length;
  const totalNodes = useMemo(() => {
    let count = 0;
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        count++;
        if (n.children) walk(n.children);
      }
    }
    walk(tree);
    return count;
  }, [tree]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-neutral-500">
        {selectedCount} of {totalNodes} selected
      </div>
      <div className="max-h-96 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 p-1">
        {tree.map((node) => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            selected={selected}
            expanded={expanded}
            onToggle={toggle}
            onExpand={toggleExpand}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  selected: Set<string>;
  expanded: Set<string>;
  onToggle: (node: TreeNode) => void;
  onExpand: (path: string) => void;
  disabled: boolean;
}

function TreeNodeRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onExpand,
  disabled,
}: TreeNodeRowProps) {
  const hasChildren = !!node.children?.length;
  const isExpanded = expanded.has(node.path);
  const checkState = getCheckState(node, selected);

  return (
    <>
      <div
        className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-neutral-900"
        style={{ paddingLeft: `${depth * 20 + 4}px` }}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onExpand(node.path)}
            className="flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-300"
          >
            <svg
              className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')}
              viewBox="0 0 12 12"
              fill="currentColor"
            >
              <path d="M4 2l4 4-4 4z" />
            </svg>
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Checkbox */}
        <input
          type="checkbox"
          checked={checkState === 'checked'}
          ref={(el) => {
            if (el) el.indeterminate = checkState === 'indeterminate';
          }}
          disabled={disabled}
          onChange={() => onToggle(node)}
          className="shrink-0"
        />

        {/* Folder icon */}
        <span className="shrink-0 text-neutral-500">
          {hasChildren ? (isExpanded ? 'dir' : 'dir') : 'dir'}
        </span>

        {/* Label */}
        <span className="truncate text-sm text-neutral-200">{node.label}</span>

        {/* File count badge */}
        {node.fileCount !== undefined && node.fileCount > 0 && (
          <span
            className={cn(
              'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none',
              BADGE_COLORS[node.badgeColor ?? 'default'],
            )}
          >
            {node.badge ?? `${node.fileCount} files`}
          </span>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <>
          {node.children!.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggle={onToggle}
              onExpand={onExpand}
              disabled={disabled}
            />
          ))}
        </>
      )}
    </>
  );
}
