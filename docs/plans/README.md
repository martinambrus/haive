# Plan archive

Durable copies of Claude Code plan files, which are otherwise auto-deleted from `~/.claude/plans`
after 30 days.

## Conventions

- **Bodies are append-only.** The original body of each plan is kept byte-identical so the plan as
  approved stays readable next to what changed. Revisions are APPENDED under an
  `# Amendment — <date>: <title>` heading, never edited in. `.prettierignore` excludes this
  directory so formatting never rewrites a body either.
- **Line numbers in a body are as-of-writing and drift.** Resolve every reference by symbol name and
  treat the number as a hint. Several plans predate large refactors; where an anchor's drift would
  mislead an implementer, the correction is recorded in that plan's amendment rather than edited in.
- **A shipped plan stays here as a record.** It is marked below and in its own amendment. Do not
  re-implement from a plan marked shipped.

## Status — 2026-08-21

Verified against the tree on this date, not taken from the plan bodies.

| Plan | Subject | Status |
|---|---|---|
| `amber-fencing-hopper` | Onboarding scope + LSP + mirror + retrieval | **In progress.** Slices 1-2 done (`e0bee51`); slice 3 partial (`5ca82ac`, 3b/3d open); slice 4 not started. Header `Status:` line is stale — see its amendment. |
| `bright-doodling-catmull` | Scope-fence the blocking reviewers | **Shipped** `3415278`. Its end-to-end benchmark re-runs are unmeasured — see its amendment. |
| `crispy-dazzling-crane` | Mid-task CLI credential harvest | **Shipped** `56a9cc3` |
| `functional-knitting-fairy` | Global KB title digest at dispatch | **Shipped** `e9c2dfe` |
| `glinting-strolling-magpie` | Browser-verification screenshot gallery | **Shipped** `34df4ef` |
| `glistening-percolating-snowflake` | Relocate KB + learnings to `.haive-data/` | **Shipped** `2b4c3ad`, `16550ae` |
| `jazzy-toasting-frog` | Phase-scoped browser weight + measured agent pool | **Shipped** `8130dcd`, `d65d83f` |
| `splendid-foraging-lynx` | Phantom worker-restart orphans + fan-out Resume | **Shipped** `d4fedf0`, `7ed0378` |
| `tidal-yielding-hoare` | Vote scoring for the runtime (DDEV) pool | **Shipped** `8b6b3a9` |
| `valiant-dancing-parrot` | Task up/down vote scoring | **Shipped** `c4d9acb` |
| `yielding-preempting-dijkstra` | Vote-driven agent-slot preemption | **Shipped** `19bf74e` |
| `kind-riding-dream` | Deep project analysis — resellable module | Not started; depends optionally on `purring-marinating-peacock` phase 2b |
| `lexical-jingling-dawn` | Learned step guidance (self-improving prompts) | Not started |
| `parsed-churning-yeti` | Project plan canvas | Not started |
| `purring-marinating-peacock` | Multi-model per step (fan-out + consolidator) | Not started; sequenced behind a cheaper fan-out change — see its amendment |
| `replicated-zooming-beacon` | Agent memory + spec handoff optimisation | Not started; all three defects re-verified as still real |
| `rippling-wibbling-puffin` | Modular (user-definable) task types | Not started |
| `rippling-wibbling-puffin-agent-a233cf7f9b59974f6` | Same feature, half A (data model, `buildRunList`, migration, seed) | Not started; companion to the above, neither supersedes the other |
| `serialized-chasing-thacker` | Haive module system — extension infrastructure | Not started |
| `translator-module` | Translator — resellable module | Not started |

## Cross-plan dependencies

- `kind-riding-dream` and `translator-module` both build on the module system in
  `serialized-chasing-thacker`, and both reference `purring-marinating-peacock`'s multi-model
  fan-out as an optional improvement, never a prerequisite.
- `serialized-chasing-thacker` and `rippling-wibbling-puffin` carry paired amendments covering the
  same joint: a module's steps must reach the composable step catalog.
- `glistening-percolating-snowflake` rides `.haive-data/`, which shipped as slice 2 of
  `amber-fencing-hopper`.
