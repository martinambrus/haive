---
name: github-rate-limit-traps
description: Four measured traps when a long-running job shares a GitHub token with other agents
metadata:
  node_type: memory
  type: reference
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-09-21T19:39:39.795Z
---

Learned the hard way building the review-corpus harvester ([[review-corpus-harvester]]), five
fixes deep. Each cost a stalled run.

- **The 5,000/hr core budget is per USER, not per process.** A batch job that runs until
  `remaining` hits 0 starves every other agent on the same token — teammates could not read
  Codex reviews on their own PRs. A long unattended job is the low-priority consumer: hold a
  floor back (`--reserve`, default 1500) and sleep rather than drain.
- **Search has its OWN budget (30/min) and reports through the SAME
  `x-ratelimit-remaining` header.** One shared counter reads whichever endpoint answered
  last: a core-sized reserve saw `29 left` from the first search response and slept forever
  having harvested nothing. Track remaining/reset PER RESOURCE.
- **Never sleep a span computed from a cached `x-ratelimit-reset`.** MEASURED, a run slept
  1606s while `/rate_limit` reported `5000/5000 used=0` the whole time, because the window had
  rolled over. `/rate_limit` does NOT count against any budget, so poll it as the source of
  truth and resume the instant headroom returns.
- **403 is overloaded.** It means throttling AND plain inaccessibility (private repo, blocked
  content). Rate limiting is identified by `x-ratelimit-remaining: 0` or the documented
  message text, never by the status alone — a permission 403 retried as a throttle is an
  infinite loop. A genuine SECONDARY limit (403 while the quota is full) clears in ~60s, so
  falling back to the primary window's reset is the wrong clock by an order of magnitude.

**Diagnostic note worth more than the fixes:** three runs stalled at the identical point and I
produced a new throttling theory each time. Reproducibility at the same point was the signal,
and the log did not name the failing URL — add that first. The eventual recovery came from
shortening the backoff (a real secondary limit rides out in ~2 min), NOT from the tidier
permission-403 story I asserted; 0 permission 403s were ever encountered.
