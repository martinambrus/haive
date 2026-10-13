export function taskUsesWorktree(
  task: { type: string; runListSnapshot?: string[] | null } | null,
): boolean {
  return (
    task?.type === 'workflow' ||
    task?.type === 'run_app' ||
    task?.runListSnapshot?.includes('01-worktree-setup') === true
  );
}
