---
name: drizzle-date-in-raw-sql-tuple
description: 'A JS Date interpolated inside a raw drizzle sql`` row-value tuple makes postgres.js throw "Received an instance of Date" at Bind; pass an ISO literal with an explicit cast'
metadata:
  node_type: memory
  type: project
  originSessionId: 2c955f67-0a5a-47cb-b6fd-7506bd02d936
  modified: 2026-09-16T07:30:03.135Z
---

In Haive's drizzle + postgres.js stack, a `Date` interpolated into a raw `sql\`(a, b) < (${date}, ${id})\``tuple fails at query time with`TypeError … Received an instance of Date` from postgres.js's Bind step,
while the same Date passed to a drizzle operator (`lt(col, date)`) works. MEASURED 2026-09-16 on the
tool-usage backfill's keyset cursor: the first batch of 25 ran, the second (the first with a cursor)
threw. The row-value tuple gives drizzle no column type to serialise against, so the Date reaches the
driver raw.

**Why:** a keyset pager that breaks on its SECOND page passes every unit test and a small dev table, and
only fails on an install big enough to page — the same "works once" shape as the short-sha and
timestamp traps.

**How to apply:** serialise the Date yourself and cast on the SQL side:
`timestampLiteral(d) = d.toISOString().replace('T', ' ').replace('Z', '')` then
`(${col}, ${idCol}) < (${lit}::timestamp, ${id}::uuid)` (PR #122, `tool-usage-backfill.ts`). The
columns are `timestamp without time zone` holding UTC wall clock, which is exactly what the stripped
ISO string is. Same family as [[drizzle-binds-arrays-as-records]]: raw `sql` fragments bind JS values
by their runtime shape, not by the column.
