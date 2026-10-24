---
name: own-post-step-verification
description: 'A check I say should happen after some later event is mine to run — keep it, watch for the event, run it, report; never hand the user a SELECT to do themselves'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2c955f67-0a5a-47cb-b6fd-7506bd02d936
  modified: 2026-09-19T12:22:58.046Z
---

When a piece of work can only be verified once a later event has happened — the next real
dispatch stamps a new column, a task reaches a step, a job runs at boot — the verification is
MINE: record what to check and what proves it, arm a watcher on the event, run the check the
moment the event has passed, and report the result. Stated by the user on 2026-09-19 after I
closed the assigned-personas work (#161) with "verify after your next run with this SELECT":
"if we have anything to check once we reach a certain point in a task, please remember that and
do it after that step has been ran, since I won't be doing the select you said to verify, but
you will."

**Why:** a check handed to the user is a check nobody runs. The user reads the summary, not the
database, and a "verify later" line in a report is indistinguishable from verified work a week
on. The whole point of measuring is that the claim gets tested against the install.

**How to apply:**

1. When a step's proof lies behind a future event, write the pending check into the plan file's
   Progress section (what event, what query or page, what a pass looks like) AND into a
   watcher that wakes the session when the event lands — the Monitor tool on a `docker exec …
psql` poll for a database condition, a CronCreate job for a periodic re-check, the
   background watch script for CI. Never leave it as prose alone.
2. When the watcher fires, run the check, judge it against the recorded pass condition, and
   report pass or fail with the measured rows. A trigger that turns out not to exercise the
   feature (a dispatch with no persona, say) re-arms the watch; it does not close the item.
3. In the final report, a pending verification is listed as OPEN with its watcher named, never
   as an instruction to the user. See [[haive-ship-cycle]] for where this sits in a ship.
