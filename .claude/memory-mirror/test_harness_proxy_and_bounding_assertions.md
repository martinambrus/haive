---
name: test-harness-proxy-and-bounding-assertions
description: "Two harness lessons that cost 8 review rounds: a permissive proxy stand-in reaches only a builder's DEFAULT arm, and an assertion written to BOUND a gap will hide it unless it names what it tolerates"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-22T16:40:25.449Z
---

Both learned building `packages/worker/src/step-engine/steps/prompt-agent-paths.test.ts` (PR #202, 34
review rounds). They are not specific to that file — any harness that sweeps many production functions
will meet them.

**1. A permissive PROXY stand-in reaches only a builder's DEFAULT arm.** A `Proxy` that answers every
property is the cheap way to drive N builders without hand-building N payloads, and it works — but it
fails EVERY strict comparison against a literal (`d.mode === 'from_repo'`), its `length` is 0, its
`map`/`flatMap`/`slice` stubs return `[]`, spreading it yields nothing, and it is TRUTHY, so it takes the
present arm of every `x ? a : b`. So "40 builders scanned" means 40 builders in their default variant.
SIX consecutive review findings on #202 were that one cause: loop roles, iteration parity, a verifier's
lenses and per-finding block, an adversary roster, a fan-out summary's over-limit arm, `for…of` over an
empty iterable.

The fix that generalises is `permissive(overrides)` — name only the fields a branch turns on and let the
proxy answer the rest. Hand-building a whole detect payload is the trade to avoid: it binds the test to
one step's shape and drifts.

**2. An assertion written to BOUND a gap will HIDE it unless it names what it tolerates.** Twice on the
same file:

- `unbuildable.length <= 12` tolerated twelve sources that produced no prompt, and FOUR were real
  read-only review prompts whose guard refused the fixture. The assertion meant to bound the gap was what
  concealed it. Fixed by splitting the bucket into `threw` (asserted EMPTY — a guard refusing a fixture is
  always the test's defect) and `selectedNothing` (honest), and asserting the remainder BY NAME, because a
  count lets a new gap take a retiring one's slot.
- A hand-written "these are scanned" list satisfied its own completeness and staleness checks while
  nothing invoked the builders. Fixed by DERIVING it from the sources that execute, plus asserting each
  claimed key belongs to a source that actually built.

**Why:** both failure modes present as GREEN. Nothing is red, the counts look healthy, and the harness
reports coverage it does not have — which is worse than no harness, because it is believed.

**How to apply.** When a sweep passes unchanged after you add a fixture, treat that as a SIGNAL, not a
pass: prove the new region renders by asserting a string only it produces. Mutate the fixture back and
confirm the assertion fails. And for any tolerance, assert the members by name and say what would make a
new member legitimate. Related: [[agent-isolation-open-items]] for the worked example,
[[own-post-step-verification]] for the same discipline applied to live checks.
