---
name: db-invariant-breaks-smoke-fixtures
description: A new unique index or constraint breaks smokes that seed states it forbids; grep every smoke for the constrained shape and run those locally before pushing
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-26T20:06:27.470Z
---

Adding a DB invariant (partial unique index, CHECK) turns every smoke fixture that SEEDS the
now-forbidden state into a failure, and unit tests on the fake DB never see it. Hit on #339
(2026-09-26): `tasks_one_live_upgrade_per_repo_idx` refused `upgrade-claims-smoke`'s second
`running` upgrade task (it left a finished rollback `running`), and `rtk-off-upgrade-smoke`'s
helpers left planned-only upgrades `running`. CI's worker `smoke:ci` chains with `&&`, so the
first failure also HIDES every later smoke in the chain.

**Why:** smokes insert rows directly to reach a scenario fast, so they routinely create states the
product itself can no longer reach once the invariant exists.

**How to apply:** before pushing an invariant, `grep -rln` the constrained table/shape across
`packages/*/test/*smoke*.ts` (and real-DB tests), run each hit against the scratch stack
(h1-smoke-pg 55432 / h1-smoke-redis 6392, with the new migration applied), and fix the FIXTURE to
the state a real run would be in (complete or cancel the earlier row), never loosen the invariant.
Related: [[worker-convention-guards-run-full-suite]].
