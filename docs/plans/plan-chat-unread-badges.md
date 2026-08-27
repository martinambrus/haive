# Plan chat: unread replies, badges, and notification routing

Deferred scope, raised while building the self-contained Chat tab. Kept separate
because it touches notifications, the tree, the tiles and the panel at once.

## Problem

A plan chat runs as a task, so it reaches the user through the task machinery:
toasts and browser notifications that open the TASK page. That is the wrong
destination — the conversation lives in the plan panel, and a notification that
navigates away from it takes the user out of the surface they were working in.

There is also no way to tell that a reply arrived while you were elsewhere in
the plan: the transcript just grows.

## Wanted

1. **Suppress task toasts for `plan_chat` while the plan canvas is open.** The
   user is already looking at the conversation; a toast about it is noise.
2. **Never raise a BROWSER notification for `plan_chat`.** Those open a new tab
   on the task page. Chat is handled in plan mode, by hand, on purpose.
3. **Unread divider** in the transcript — the chat-app convention: everything
   after the last message the user saw sits below a line.
4. **Unread badge on the node** in both tree and tiles, on the node the reply
   belongs to ONLY. Explicitly not rolled up to ancestors: a badge on a parent
   would send the user hunting through a subtree.
5. **Unread badge on the Chat tab** in the panel when that tab is not the open
   one, so the node badge has a visible destination.
6. **Clearing**: reading the messages clears every badge for that node.

## Open questions to settle when this is planned properly

- Where "last read" lives. Per user per node, so it follows the account like the
  other plan prefs — `user_ui_prefs` is per-user but schemaless and unbounded
  growth per node is a poor fit; a small table keyed `(user_id, node_id)` with a
  `last_read_at` is probably right.
- What counts as read: opening the Chat tab on that node, or the transcript
  actually being scrolled to the bottom.
- How the tree/tiles learn about unread counts without a request per node — the
  plan tree endpoint would need to carry a count, computed from
  `plan_node_messages.created_at > last_read_at`.
- Whether suppression should key on the plan page being OPEN (a live signal) or
  on the task type alone (simpler, and arguably right: a plan chat should never
  toast, since its home is the panel).

## Related code

- Toasts: `packages/web/src/components/notifications/toast-stack.tsx`
- Chat transcript + grouping: `packages/web/src/components/plan/plan-chat.tsx`,
  `plan-chat-groups.ts`
- Tree/tiles: `packages/web/src/components/plan/plan-tree.tsx`,
  `plan-card-grid.tsx`
- Messages API: `packages/api/src/routes/plan.ts` (`/plan/nodes/:nodeId/messages`)
