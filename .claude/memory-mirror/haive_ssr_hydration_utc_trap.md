---
name: haive-ssr-hydration-utc-trap
description: "Reading Intl timezone or Date.now() during render of a 'use client' page mismatches on hydration — the containers run UTC — and the visible symptom is a blank chart, not an error"
metadata:
  node_type: memory
  type: project
  originSessionId: 2280e8c6-abbb-42aa-9928-57f6f6e29472
  modified: 2026-09-06T13:38:35.584Z
---

Every data-fetching page in `@haive/web` is `'use client'`, but Next still server-renders it,
and **the containers run UTC** while the browser does not. So anything read during RENDER that
differs between the two produces a hydration mismatch:

- `Intl.DateTimeFormat().resolvedOptions().timeZone` — `UTC` on the server, `Europe/Prague` in
  the browser. Fatal even inside a `useState(() => …)` initializer, which also runs on the server.
- `Date.now()` — differs by milliseconds, and it matters when the value reaches the DOM (a
  relative window baked into an `href` is compared attribute by attribute).

**Why it is worth a note:** the symptom is not an obvious error. On 2026-09-06 the visible
failure was a **blank recharts chart** — React discarded and regenerated the tree, and
`ResponsiveContainer` measured during the discard and drew nothing. I nearly "fixed"
ResponsiveContainer. The real message was only in the console
(`Hydration failed because the server rendered text didn't match the client`), and fixing the
hydration fixed the chart with no chart-code change at all.

**How to apply:** resolve both on the client and hold them in state — `useState<string | null>
(null)` plus a mount `useEffect` — and gate the first fetch on non-null so the request goes out
once with the right value. Never seed state from `Intl`/`Date.now()`. When a chart or widget
renders blank, read the console BEFORE touching the component: `list_console_messages` with no
type filter. Next's dev-tools badge in the corner shows an issue count for exactly this.
Related: [[chrome-mcp-browser-check-gotchas]].
