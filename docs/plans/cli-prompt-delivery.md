# A large prompt must not crash the CLI that receives it

## Context

A Codex plan build failed 26 of its 47 finished agents, all with the same error:

```
spawn E2BIG   × 27
```

Not a model problem — the agents never started. Linux caps a single argv entry
at `MAX_ARG_STRLEN` (128 KiB), and every adapter but one passes the prompt as an
argument. Plan-expansion prompts embed the rendered plan, so they cross that line
as the plan grows: waves 1-2 mostly worked, waves 3 and 4 lost 12 of 12.

Claude escapes it by accident. `claudeFamilyArgs` (`cli-adapters/steering.ts:52`)
emits `-p` with NO prompt argument when steering and sends the text through
`stdinInitial`; the same builder's non-steering branch passes `-p <prompt>` as
argv and is exposed exactly like the rest.

MEASURED across the adapters — six families are exposed: `codex` (positional),
`gemini`/`grok`/`antigravity` (`-p <prompt>`), `amp` (`-x <prompt>`), and the
claude family whenever a run is not steerable.

This matters beyond one build: it silently invalidates any model comparison,
because the model that happens to route through stdin gets to answer and the
others are killed before they think.

**Rollback.** Delivery is chosen by one helper behind a per-adapter capability
flag. Reverting the flag returns every adapter to argv exactly as today.

## A. Deliver a large prompt over stdin

`packages/worker/src/cli-adapters/types.ts`, `sandbox/docker-runner.ts`

`CliCommandSpec` gains `stdinPrompt?: string`: written to the child's stdin,
which is then CLOSED.

The close is the whole point and is what makes this different from the existing
`stdinInitial`. Steering keeps stdin open forever so a steer can arrive
mid-run; a prompt delivered this way must end the stream, or the CLI waits for
input that never comes and dies on the timeout instead of E2BIG. The runner
currently opens stdin only when `interactive` (`docker-runner.ts:156`), so
`stdinPrompt` must also force the pipe. The two are mutually exclusive and the
spec says so.

## B. One helper decides, per adapter capability

A shared `deliverPrompt(prompt, { stdin })` used by every `buildCliInvocation`:
over the threshold AND the adapter supports stdin, it returns
`{ stdinPrompt }` and the caller omits the positional; otherwise the prompt goes
in argv as today.

- **Threshold, not always.** The minimal change that fixes the crash, and the
  large-prompt path is not a rare one — it was taken 27 times in a single build,
  so it gets exercised rather than rotting.
- **Measured in BYTES.** `MAX_ARG_STRLEN` counts bytes and a JS string counts
  UTF-16 units; `Buffer.byteLength` is the only honest measure for a document
  full of typographic dashes.
- 64 KiB, half the kernel limit, because argv also carries the other flags and
  the environment.

Enabled where the CLI's own `--help` documents stdin, verified in the shipped
sandbox images:

- **codex** — "instructions are read from stdin"
- **amp** — "argument, or via stdin"
- **claude family** — already proven by the steering path

## C. The rest fail clearly instead of cryptically

`grok`, `gemini` and `antigravity` document no stdin input. For them an
oversized prompt now raises a named error stating the prompt's size, the limit
and the adapter, instead of `spawn E2BIG` from somewhere inside node.

That IS the fix for those three: the failure becomes diagnosable in one read
rather than after an afternoon. Making them work needs a probe of each CLI's
real stdin behaviour, which `--help` cannot settle — recorded as follow-up
rather than guessed at.

## Files

- `packages/worker/src/cli-adapters/types.ts` (`stdinPrompt`, the capability flag)
- `packages/worker/src/cli-adapters/prompt-delivery.ts` (new; the helper + limit)
- `packages/worker/src/sandbox/docker-runner.ts` (pipe + write + end)
- The six adapters, each a two-line change at its `args` construction
- Tests beside the helper and the adapters

## Verification

1. Unit on the helper: under the threshold goes to argv; over it goes to stdin
   when supported; over it THROWS the named error when not; the measure is bytes
   (a multi-byte string near the boundary must not be mis-sized).
2. Unit per adapter: each large-prompt spec carries `stdinPrompt` and no
   prompt in `args`; each small-prompt spec is byte-identical to today's, which
   is what protects every existing run.
3. Runner: `stdinPrompt` opens the pipe, writes, and ENDS it — asserted by a
   fake child, since a CLI left waiting on an open stdin fails as a timeout and
   would look like a slow model rather than a wiring bug.
4. Live, cheap and decisive: re-run the Codex plan build that produced 27 E2BIG
   failures and confirm the agents start. That build is the regression test —
   nothing synthetic reproduces a 128 KiB prompt as faithfully.
5. Per-container tsc, prettier, vitest in worker; `smoke:plan-canvas`.
6. NOT verified: that grok/gemini/antigravity can accept a prompt any other way.
   They will refuse loudly, which is the claim being made about them.
