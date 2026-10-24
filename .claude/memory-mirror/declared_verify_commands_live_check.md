---
name: declared-verify-commands-live-check
description: "PARKED for the next real workflow run: step 08 running a repository's DECLARED verify command (#72, PRs #580/#584/#583) was only unit-tested — set one on the Tooling page before the task, then check 06, 08 and gate 2"
metadata:
  node_type: memory
  type: project
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-12T11:33:24.769Z
---

#72 (shipped 2026-10-12) lets a repository declare its own test/lint/typecheck commands on its Tooling
page (`repositories.verify_commands`; key absent = Auto, `null` = Off, string = Custom). The UI was
browser-checked live and saves exactly; the WORKER side (`08-phase-5-verify` running the command) was
covered by unit tests only, because it needs a real workflow task.

**Before the task (set it up, it is read at step time but do it first):** on the test repo's Tooling
page, set ONE slot Custom with a command that exists in that environment (DDEV: e.g.
`vendor/bin/phpunit --version`; host: e.g. `node --version`) and one slot Off. Confirm the row:
`select verify_commands from repositories where id=…`.

**Checks when the run reaches the steps:**

1. `06-run-config` form shows a note "Verify commands declared for this repository" listing them.
2. `08-phase-5-verify`:
   - its form lists the slots in a code block, the custom one labelled `(declared)`, the Off one
     "turned off for this repository";
   - the declared command actually RAN as one shell string: DDEV `exec --raw -- bash -c '<cmd>'`,
     host `sh -c <cmd>` (look at the step output / `task_steps.output` for that slot: `ran: true`,
     its exit, its output);
   - the Off slot ran nothing and the note says it is turned off.
3. `09-gate-2-verify-approval`: the Off slot is NOT shown as a missing runner (no "Tooling below the
   root" row caused by it); a root-only NOT RUN body ends with the Tooling-page hint.
4. Optional negative: a Custom command whose program does not exist (`nosuchtool --x`) must read NOT
   RUN with "command not found / not executable" and spend NO fix round; a Custom command that starts
   but fails (`sh -c 'exit 127'` inside a script) must be an ordinary failure that DOES loop.

**After:** reset the repo's slots to Auto on the Tooling page (row back to NULL). Close this memory
and its rows in [[onboarding-run-checkpoints]].
