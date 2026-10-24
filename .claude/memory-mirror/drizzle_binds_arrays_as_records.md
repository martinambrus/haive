---
name: drizzle-binds-arrays-as-records
description: 'In a drizzle `sql` template a bare ${array} expands to a parenthesised record, not one array param - use sql.param() when the operator wants a real array'
metadata:
  node_type: memory
  type: reference
  originSessionId: 0c9cf9fa-19ae-4f91-baad-0afa8e2d8979
  modified: 2026-09-06T22:40:48.623Z
---

In a drizzle `sql` template, interpolating a JS array expands it to a parenthesised list of
placeholders — `($1, $2, $3)`, a record — not a single array parameter. Any operator or cast
that wants a real array then fails:

```
PostgresError: cannot cast type record to text[]   (code 42846)
```

Bind it as one parameter instead:

```ts
sql`${schema.tasks.changedPaths} ?| ${sql.param(paths)}::text[]`;
```

**Why:** the record form is right for `IN (…)`, which is the common case, so the failure only
shows up the first time an array reaches an operator like `?|`, `&&` or `= ANY(...)` — and it
fails at RUNTIME against a real database, not at typecheck. Cost a live probe to find on
2026-09-06 while adding `fileOverlapTaskIds` (`worker/src/step-engine/steps/workflow/_estimate.ts`).

**How to apply:** whenever a `sql` fragment passes a JS array to anything other than `inArray`,
wrap it in `sql.param()` and keep the explicit cast. Verify against live Postgres — a unit test
with a faked db proves nothing about the emitted SQL. Related:
[[haive-applying-a-migration]].
