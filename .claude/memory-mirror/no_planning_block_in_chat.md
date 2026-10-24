---
name: no-planning-block-in-chat
description: 'Never write the "what I need next" planning enumeration into chat; keep that reasoning internal'
metadata:
  node_type: memory
  type: feedback
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-16T12:49:56.689Z
---

Do not emit a visible "Privately, what I need next: 1… 2… 3…" block (or any similar
enumeration of pending/blocked/unblocked items) in chat replies. Keep that reasoning
internal and write only outcomes, decisions, and what is still running.

**Why:** the user raised it directly — it appeared after nearly every message and
inflates the context window, which on a long multi-PR series is a real cost, not a
cosmetic one. The enumeration is planning scaffolding; its conclusions are the only
part with value to a reader.

**How to apply:** a short framing sentence then the substance. When work is blocked on
something (CI, a watcher, a background task), say so in one line — "CI on <sha> still
running, holding for it" — rather than restating the whole dependency graph. Still fine
to name what is gated and why when it genuinely changes what the user would do next.
Related: [[neutral_wording_for_security_work]].
