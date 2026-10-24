---
name: taskupdate-description-replaces
description: "TaskUpdate's description field replaces the whole text — TaskGet before appending to a task"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-16T14:14:54.801Z
---

`TaskUpdate { description }` overwrites the task's description; it does not append. On 2026-10-16 an "add two items" update wiped #300's 16-item list, recovered only by parsing the session JSONL for the original TaskCreate.

**Why:** umbrella and bundle tasks (FNF heads, #300) carry their item lists only in the description; a blind update loses them.

**How to apply:** before adding to a task's description, `TaskGet` it and write back the full text plus the new items; bundle heads under [[fnf-items-as-tasks]] are the common case.
