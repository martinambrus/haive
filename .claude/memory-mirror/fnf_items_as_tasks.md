---
name: fnf-items-as-tasks
description: Every haive session files verified found-not-fixed items in the task list BY BUNDLE; the procedure is the "Found, not fixed: tasks by bundle" section of /sonnet-sonnet (same in /opus-opus), the map is in the running list
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-17T12:54:14.126Z
---

Every verified found-not-fixed item goes into the task list by bundle, in every haive session,
whether or not a driver skill is running. The procedure is the "Found, not fixed: tasks by bundle"
section of `~/.claude/commands/sonnet-sonnet.md` (same text in `opus-opus.md`; the retired
`/opus-sonnet` it came from is in `~/.claude/skill-archive/`); read it before recording an item.

**Why:** the user, 2026-10-01: "keep writing all new found and not fixed issues directly as tasks,
so we can keep on cleaning this up until we fixed all that we can". On 2026-10-03, with 57 one-item
FNF tasks queued, each heading for its own PR and its own Codex rounds: "automatically bundle newly
found items from found and not fixed list, so they don't get added 1 by 1 at the end of the
tasklist", then "let's fold FNF-to-task rule with bundling into /opus-sonnet". The rule lives in the
command so that it holds in every project. This file keeps only what is specific to haive.

**Haive specifics:**

- The durable list is [[found-not-fixed-running-list]]. Its "Bundles" section is the bundle map
  (slug, member tasks and shared code, in planned order). Each new item's entry names its bundle and
  head task.
- Task lists are per session. Session 3813bbf6's list carries the `FNF[<slug>]:` tags. The
  house-rules session (f3f0c544) tags its own tasks.

- File at the moment an item is verified, not at the PR's end. That includes items I find myself
  while fixing review rounds directly, and items an agent reports. On 2026-10-14 the user caught
  14 Codex rounds on #670 whose leftovers sat only in the ledger and chat reports. Dropped items
  get a reason in the ledger. An item from a peer session in my area gets taken over and filed here,
  and the peer is told so it drops its copy.

Related: [[haive-opus-sonnet-workflow]], [[found-not-fixed-sweep-3-series]].
