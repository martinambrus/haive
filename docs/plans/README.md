# Plan archive

Durable copies of Claude Code plan files, which are otherwise auto-deleted from `~/.claude/plans`
after 30 days.

## Conventions

- **Revisions are folded into the section they belong to. No `# Amendment` sections.** A plan is
  read by people and by agents, and an amendment splits one subject across two places: the body
  keeps stating a superseded count or budget while a correction sits hundreds of lines below it.
  When something changes, edit the section that is wrong, mark an implementation departure inline as
  **As built**, and put the whole-plan verdict in a blockquote under the H1. `.prettierignore`
  excludes this directory, so formatting never rewrites a body either.
- **Line numbers in a body are as-of-writing and drift.** Resolve every reference by symbol name and
  treat the number as a hint. Several plans predate large refactors; where an anchor's drift would
  mislead an implementer, the corrected anchor is written in beside the original.
- **A shipped plan stays here as a record.** It is marked below and in a status blockquote under its
  own H1. Do not re-implement from a plan marked shipped.

## Status — 2026-08-21

Verified against the tree on this date, not taken from the plan bodies.

| Plan | Subject | Status |
|---|---|---|
| `amber-fencing-hopper` | Onboarding scope + LSP + mirror + retrieval | **In progress.** Slices 1-2 done (`e0bee51`); slice 3 partial (`5ca82ac`, 3b/3d open); slice 4 not started. Per-slice status is in its header blockquote. |
| `bright-doodling-catmull` | Scope-fence the blocking reviewers | **Shipped** `3415278`. Its end-to-end benchmark re-runs are unmeasured. |
| `crispy-dazzling-crane` | Mid-task CLI credential harvest | **Shipped** `56a9cc3` |
| `functional-knitting-fairy` | Global KB title digest at dispatch | **Shipped** `e9c2dfe` |
| `glinting-strolling-magpie` | Browser-verification screenshot gallery | **Shipped** `34df4ef` |
| `glistening-percolating-snowflake` | Relocate KB + learnings to `.haive-data/` | **Shipped** `2b4c3ad`, `16550ae` |
| `jazzy-toasting-frog` | Phase-scoped browser weight + measured agent pool | **Shipped** `8130dcd`, `d65d83f` |
| `splendid-foraging-lynx` | Phantom worker-restart orphans + fan-out Resume | **Shipped** `d4fedf0`, `7ed0378` |
| `tidal-yielding-hoare` | Vote scoring for the runtime (DDEV) pool | **Shipped** `8b6b3a9` |
| `valiant-dancing-parrot` | Task up/down vote scoring | **Shipped** `c4d9acb` |
| `yielding-preempting-dijkstra` | Vote-driven agent-slot preemption | **Shipped** `19bf74e` |
| `external-change-catchup` | KB + plan catch-up for commits made outside Haive | **Shipped** `f177e2f` / `e799f08` / `7a01345`, plus `ca4b64b` for a tree-resolution defect found reviewing slice 2. Repo-page drift badge deferred by design |
| `frictionless-bootstrapping-otter` | One-line install (RUN-IT) | Not started; extended 2026-09-07 with the install-time channel, macOS as a first-class RUN-IT target, and a Docker Desktop Extension as the no-terminal path |
| `kind-riding-dream` | Deep project analysis — resellable module | Not started; depends optionally on `purring-marinating-peacock` phase 2b |
| `lexical-jingling-dawn` | Learned step guidance (self-improving prompts) | Not started |
| `parsed-churning-yeti` | Project plan canvas | Not started |
| `patient-pinning-kernighan` | Runtime versions the generator ignores (Go/Rust/Ruby, DDEV node) | Not started; three different failures — Go is frozen, Rust/Ruby drift, DDEV node is detected then dropped — so one blanket fix would trade one for another |
| `nimble-browsing-lovelace` | User-selectable browser type + version | **Shipped** `dde9c36` / `bc1b209` / `abb5609` for Chrome + Edge, each gated on a verified CDP handshake. Opera REJECTED on evidence — release builds do not expose CDP. Firefox excluded as a COST decision, not an impossibility — @playwright/mcp drives firefox and webkit |
| `purring-marinating-peacock` | Multi-model per step (fan-out + consolidator) | Not started; Phases 1-2 BACKLOGGED on a hand-merge measurement that failed its reopening condition. The fan-out unpin is carved out as the one piece worth building |
| `quiet-reaping-ritchie` | DevTools egress hardening follow-ups | **Shipped** `c094102` (item 1, runner `--init`) and `e066d26` (item 2, MCP body diversion), both verified against real traffic. Two browser defects found while verifying, plus a poisoned-npx-cache defect found with them, are fixed in `b7884e6` / `0580c51` / `507cb84`. Both bandwidth caveats are retired: nothing here passes `--no-cache`, and the apt cost is once per host, not once per template |
| `replicated-zooming-beacon` | Agent memory + spec handoff optimisation | Not started; all three defects re-verified as still real |
| `rippling-wibbling-puffin` | Modular (user-definable) task types | Not started |
| `rippling-wibbling-puffin-agent-a233cf7f9b59974f6` | Same feature, half A (data model, `buildRunList`, migration, seed) | Not started; companion to the above, neither supersedes the other |
| `serialized-chasing-thacker` | Haive module system — extension infrastructure | Not started. Delivery to a published-image install DECIDED 2026-09-07: per-customer api+worker images built by the vendor; `frictionless-bootstrapping-otter`, `kind-riding-dream` and `translator-module` inherit it |
| `steadfast-committing-gray` | Core upgrade — release, transactional apply, maintenance mode | **Slices 1-4 shipped** 2026-09-08 (migration runner, frozen baseline, adoption, data-migration split; version stamping, `/version`, release manifest; tag-triggered multi-arch publish + compose run overlay, inert until a tag is pushed; maintenance mode + admin task control). Slice 5 — the updater — not started |
| `translator-module` | Translator — resellable module | Not started |

## Cross-plan dependencies

- `kind-riding-dream` and `translator-module` both build on the module system in
  `serialized-chasing-thacker`, and both reference `purring-marinating-peacock`'s multi-model
  fan-out as an optional improvement, never a prerequisite.
- `serialized-chasing-thacker` and `rippling-wibbling-puffin` carry paired rules covering the same
  joint: a module's steps must reach the composable step catalog.
- `glistening-percolating-snowflake` rides `.haive-data/`, which shipped as slice 2 of
  `amber-fencing-hopper`.
- `steadfast-committing-gray` and `frictionless-bootstrapping-otter` share one slice exactly:
  published images plus the compose `run` overlay are otter's RUN-IT prerequisite and gray's Phase 0
  prerequisite. Whichever ships first builds them. Otter owns the FIRST install; gray owns every
  install after it, which is the follow-up otter names and defers. They also share the CHANNEL: gray
  made the release manifest per-channel for upgrades, and otter resolves the same channel at install
  time — an installer that always fetched the public manifest would hand a module customer the wrong
  stack before any upgrade happened.
- `steadfast-committing-gray` generalises `serialized-chasing-thacker`'s urgent/graceful drain
  choice from module scope to system scope.
- **Decided 2026-09-07, spanning four plans:** a published-image install has no source and no build,
  while a module is rebuild-on-install — so such an install could run no modules, including the paid
  ones the module system exists to sell. Resolved in favour of **per-customer api+worker images
  built by the vendor**, derived from a base release, with web left as the stock public image. The
  reasoning and the two rejected alternatives live in `serialized-chasing-thacker` under "DECIDED —
  a published-image install gets PER-CUSTOMER images built by the vendor", because it is that plan's
  locked rebuild-on-install constraint that created the conflict. A user's OWN module is the other
  half of the same decision and does NOT force them into a developer checkout: the stack runs a
  published `haive-builder` image as a one-shot to build api+worker locally. Four-cell delivery
  matrix in that section. `frictionless-bootstrapping-otter` (RUN-IT), `kind-riding-dream` and
  `translator-module` inherit it; `steadfast-committing-gray` carries two consequences — a
  per-channel release manifest, and a Phase 0 local rebuild for installs that carry own modules.
- Authoring a TASK TYPE is unaffected by all of the above: `rippling-wibbling-puffin` makes task
  types data and states at Phase 3.1 that prompt-template steps need no rebuild. Only a module
  contributing steps, routes or jobs requires a build.
