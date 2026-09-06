import type { PlanNodeTaskRole } from '@haive/shared';

/**
 * A task someone is about to create, handed from the plan to the create form.
 *
 * sessionStorage, NOT the module memory `task-origin.ts` uses, and the reason is
 * that the two want opposite things from a ctrl-click. An ORIGIN copied into a
 * link-opened tab is wrong — that tab would claim a plan it never showed — so
 * origins deliberately live in memory and a new tab falls back. A DRAFT copied
 * into a new tab is exactly right: it is what the user asked to carry there, and
 * an empty form would just look broken.
 *
 * Not the URL either. A decomposition rationale runs to paragraphs, which is past
 * what a query string should carry, and the create form is a place people arrive
 * at from links they might share.
 *
 * Keyed by a token so two drafts stashed from two tabs cannot overwrite each
 * other, and read-once so a reload of the form does not resurrect a draft the
 * user has already edited away from.
 */
export interface TaskDraft {
  title: string;
  description: string;
  planNodeIds: string[];
  planNodeRole: PlanNodeTaskRole;
  /** Set when a plan chat proposed this. Reaches `tasks.metadata.fromPlanChat`,
   *  which is what stops 00-triage suggesting the user go back to the plan. */
  fromPlanChat?: boolean;
}

const PREFIX = 'haive.taskDraft.';

/** Stash a draft and return the token to put in the create form's URL. Returns
 *  null when storage is unavailable (private mode, blocked site data), so the
 *  caller can fall back to a link that carries only what fits in the query. */
export function stashTaskDraft(draft: TaskDraft): string | null {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    sessionStorage.setItem(`${PREFIX}${token}`, JSON.stringify(draft));
    return token;
  } catch {
    return null;
  }
}

/** Drafts already taken out of storage this session.
 *
 *  Read-once means once out of STORAGE, not once per call. The create form reads
 *  this from a `useMemo`, and React re-invokes that during a StrictMode double
 *  render — a plainly destructive read would hand the second pass null and the
 *  form would come up blank in development only. */
const taken = new Map<string, TaskDraft>();

/** The stashed draft for a token, removed from storage as it is first read. A
 *  missing or unreadable entry is null rather than an error: the form still
 *  works, it just starts blank. */
export function readTaskDraft(token: string | null): TaskDraft | null {
  if (!token) return null;
  const already = taken.get(token);
  if (already) return already;
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${token}`);
    sessionStorage.removeItem(`${PREFIX}${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TaskDraft>;
    if (!Array.isArray(parsed.planNodeIds)) return null;
    const draft: TaskDraft = {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      planNodeIds: parsed.planNodeIds.filter((id): id is string => typeof id === 'string'),
      planNodeRole: parsed.planNodeRole === 'implements' ? 'implements' : 'touched',
      ...(parsed.fromPlanChat === true ? { fromPlanChat: true as const } : {}),
    };
    taken.set(token, draft);
    return draft;
  } catch {
    return null;
  }
}

/** The create-form URL for a node set, with the draft stashed behind a token.
 *  Falls back to ids in the query when storage refused, so the link still
 *  carries the set even though the prose is lost. */
export function taskDraftHref(repositoryId: string, draft: TaskDraft): string {
  const token = stashTaskDraft(draft);
  const params = new URLSearchParams({ repositoryId });
  params.set('planNodeIds', draft.planNodeIds.join(','));
  if (token) params.set('draft', token);
  else if (draft.title) params.set('title', draft.title);
  return `/tasks/new?${params.toString()}`;
}
