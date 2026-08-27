# Plan chat: unread replies, badges, and notification routing

STATUS: SHIPPED. Every item below is implemented; this file is kept as the
rationale record, not as outstanding work.

Raised while building the self-contained Chat tab and kept separate because it
touches notifications, the tree, the tiles and the panel at once. Implemented
across `2e421548` (read table), `e5e36165` (feed exclusion + unread endpoint)
and `6355ae84` (badges, divider, filter), covered by
`packages/api/test/plan-chat-surfaces-smoke.ts` and
`packages/web/src/components/plan/plan-chat-turn.test.ts`.

## Problem

A plan chat runs as a task, so it reaches the user through the task machinery:
toasts and browser notifications that open the TASK page. That is the wrong
destination — the conversation lives in the plan panel, and a notification that
navigates away from it takes the user out of the surface they were working in.

There is also no way to tell that a reply arrived while you were elsewhere in
the plan: the transcript just grows.

## Wanted, and where each landed

1. **Suppress task toasts for `plan_chat`** — the user is already looking at
   the conversation, so a toast about it is noise. Landed without any
   notification-specific code: the notifier polls the task list, which now
   hides chats by default (`notification-provider.tsx:49`).
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

## Questions that were open, and how they were settled

- Where "last read" lives: `user_plan_node_reads`, keyed `(user_id, node_id)`
  with a `last_read_at` (migration `0134`). `user_ui_prefs` was rejected —
  per-user but schemaless, and unbounded growth per node is a poor fit.
- What counts as read: opening the Chat tab on that node. Scroll position was
  rejected — a short conversation never scrolls, so it would never clear.
- How the tree/tiles learn the counts: one endpoint, `GET /:id/plan/unread`,
  returning a nodeId→count map. Not folded into the tree endpoint — tree,
  node-detail and overview are three calls that all bottom out in `toNodeViews`,
  so it would have cost three aggregates per refresh and changed a type the
  worker shares.
- Suppression keys on the TASK TYPE alone, not on the plan page being open: a
  plan chat's home is the panel, so it should never toast from anywhere. The
  task list gained `?includeChats=1` to bring them back on demand, and the
  repository badge counts were excluded to match — a badge counting tasks the
  list refuses to show is the failure this change existed to prevent.

## Related code

- Toasts: `packages/web/src/components/notifications/toast-stack.tsx`
- Chat transcript + grouping: `packages/web/src/components/plan/plan-chat.tsx`,
  `plan-chat-groups.ts`
- Tree/tiles: `packages/web/src/components/plan/plan-tree.tsx`,
  `plan-card-grid.tsx`
- Messages API: `packages/api/src/routes/plan.ts` (`/plan/nodes/:nodeId/messages`)
