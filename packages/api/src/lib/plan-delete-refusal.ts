/** A plan task that is still able to write to the plan. */
export interface OpenPlanTask {
  id: string;
  title: string;
  type: string;
}

export interface PlanDeleteRefusal {
  status: 409 | 400;
  code: string;
  message: string;
  /** Present on the in-flight refusal, so the UI can link them. */
  tasks?: OpenPlanTask[];
}

/**
 * Whether a plan delete may proceed, and why not when it may not.
 *
 * A pure decision so both guards can be tested without standing up the route.
 * Deleting a plan destroys every node, edge, code link and chat transcript
 * attached to it, and the only undo is a committed `.haive-data/plan.json` plus
 * a re-clone — so the guards are the feature, not decoration around it.
 */
export function planDeleteRefusal(args: {
  /** What the caller typed. */
  confirm: unknown;
  /** What it has to equal. */
  repoName: string;
  openTasks: OpenPlanTask[];
}): PlanDeleteRefusal | null {
  // In-flight first. Told to stop typing before being told the typing was
  // wrong: the task is the thing they have to deal with either way, and a name
  // mismatch is noise until it is dealt with.
  if (args.openTasks.length > 0) {
    return {
      status: 409,
      code: 'plan_tasks_open',
      message:
        args.openTasks.length === 1
          ? 'A plan task is still running against this plan. Cancel it first — a builder wave finishing after the delete would rebuild part of the plan out of nothing.'
          : `${args.openTasks.length} plan tasks are still running against this plan. Cancel them first — a builder wave finishing after the delete would rebuild part of the plan out of nothing.`,
      tasks: args.openTasks,
    };
  }

  // Re-checked here and not only in the dialog: the dialog is an affordance,
  // this endpoint is what anything else calls, and a destructive endpoint
  // cannot take the caller's word that a human was asked.
  //
  // Trimmed, because a copy-paste picks up whitespace; not lowercased, because
  // this is the one place where "close enough" is the wrong answer.
  const expected = args.repoName.trim();
  // A repository with no usable name would make the check `'' === ''` — the
  // guard silently disappearing at exactly the moment it is load-bearing.
  // Refuse instead: there is no way to type a confirmation that does not exist.
  if (expected.length === 0) {
    return {
      status: 400,
      code: 'plan_delete_unconfirmable',
      message:
        'This repository has no name to confirm against, so the plan cannot be deleted from here. Name the repository first.',
    };
  }
  const typed = typeof args.confirm === 'string' ? args.confirm.trim() : '';
  if (typed !== expected) {
    return {
      status: 400,
      code: 'plan_delete_confirm_mismatch',
      message: 'Type the repository name exactly to confirm.',
    };
  }

  return null;
}
