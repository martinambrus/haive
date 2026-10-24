---
name: ddev-rag-test-db-cleanup
description: "A throwaway database created inside the user's real herplast2 DDEV postgres to test ragMode 'ddev' must be dropped once that test has run — not before (it had not, on 2026-09-15)"
metadata:
  node_type: memory
  type: project
  originSessionId: 7b103635-8824-4e07-9760-f6a4061bf2b8
  modified: 2026-09-15T13:38:16.060Z
---

Created 2026-09-11 to test `ragMode: 'ddev'` on onboarding task
`cbf0be06-32e0-46da-884d-9dca1affc2f6` (repo `elmont_rs_test2`). The user asked to be
reminded to clean it up once the RAG testing finishes.

```bash
docker exec ddev-herplast2-db psql -U db -d db -c "DROP DATABASE haive_rag_ddevtest;"
```

**Status 2026-09-15: kept, by the user's rule** — drop it once the test has given us what we need,
otherwise wait for the step it is kept for. The test is `10-rag-populate` on `cbf0be06`, and that run
was parked at `09_2-qa-resolve` with no RAG step ever run (`elmont_rs_test2` still carries
`ragMode: ddev` pointed at `haive_rag_ddevtest`); the herplast2 DDEV project was not running either.
Drop it after that step has populated the database and the result has been looked at.

`elmont_rs_test2` has no DDEV project of its own and onboarding never starts one, so the
test borrows postgres from the user's REAL `herplast2` project. A separate database was
created deliberately: `ensureRagSchema` issues DDL (`CREATE EXTENSION vector`, the tables,
indexes, `update_content_tsv`) against whatever it is pointed at, and herplast2's own `db`
schema must not collect Haive's RAG tables.

Connection string given to the user, verified from inside haive-worker with the shipped
postgres driver:
`postgresql://db:db@host.docker.internal:59002/haive_rag_ddevtest`

Two live hazards while it runs: herplast2 must stay up, and **DDEV reassigns ports** — a
`ddev restart` can move 59002, which surfaces as a connection failure at
`10-rag-populate`; re-read it with `ddev describe`. That port volatility is why
`resolveRagConnection` refuses to guess a DDEV address at all.

NOT pending: haive-worker and haive-api were briefly attached to the `ddev_default`
docker network while diagnosing reachability, and both were disconnected again the same
day — `host.docker.internal` works on the stock network, so no network change is needed
or outstanding.

Related: [[global-kb-purge-pending]]
