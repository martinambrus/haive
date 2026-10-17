# What "The Economic Benefit of Refactoring" offers Haive: what agents read, and refactors measured by it

> **Not started** 2026-10-17. One source: Giles Edwards-Alexander, "The Economic Benefit of
> Refactoring", martinfowler.com (Exploring Gen AI), 30 July 2026. Four items, turned into phases.
> Nothing is approved. P0 gates the rest: without a record of what agents read there is no hotspot
> to refactor and no number to judge a refactor by. P2 is parked; P3 is the owner's decision. Keep
> this file current by editing the section a change belongs to.

## Context

The user asked what Haive could take from the article. Every Haive claim below was read on `main`
`ba51bf50c` on 2026-10-17. The measurements were taken on the dev install the same day, by scripts
kept untracked in `.claude/tmp/read-cost/` with their outputs; they are the reference P0 must
reproduce.

## The source

An application of ~150k lines (mostly Rust), written entirely by agents, had grown a 17,155-line
data-access file full of duplicated HTTP and JSON handling. The author planned a sequence of
refactorings and, after each one, gave a fresh sub-agent the same representative feature prompt (a
new store trait with three methods, implemented for the fake and the real store), recorded what it
read, and discarded its change.

- Input tokens per change fell from 159,564 to 27,360 (−83%); the largest file went from 17,155 to
  3,695 lines. Total code size stayed roughly the same, and output tokens stayed at ~1.7-2.5k. The
  saving came from the agent reading less code, not from there being less of it.
- Order mattered. The early extractions saved little, and one cost +17k; the large drops came from
  moving code into modules by domain, and the final split alone gave ~80k of the ~132k saved. The
  author's reading: a split helps only once duplication is gone and the code a change needs sits
  together; an arbitrary split makes the agent read several files instead of one.
- The agent chose refactorings poorly and needed a human to steer; the most valuable step was
  missed on the first pass. It applied refactorings with grep/sed scripts that broke indentation.
- Caveats the author states: one greenfield application, one representative change, token counts
  estimated as characters / 4, a price of $3 per million input tokens with no cache discount, and
  the cost of the refactoring itself unmeasured (upper bound ~5M tokens).

## Measured in Haive

Method: each tool result counts as characters / 4 times the number of later model turns in the same
context, since every later API call re-sends it; its life ends at a `compact_boundary` event. It is
attributed to a file through the read tool's path or a `cat`/`sed -n`/`head`/`tail` command line.

- **M1. Repository file content is 13.8% of agent prompt tokens** on the install (all tool results
  19.4%), over 2,722 claude-family runs with turns (16 excluded, M5). The median run is 0% (plan
  steps call no tools), p95 20.3%. By step (these per-step figures include the 16): 08 knowledge
  acquisition 28.7%, 08c review 18.7%, 07b 16.4%, 06c DAG execute 14.9%, 08b 14.3%, 07 14.0%,
  02-plan-coverage 2.0%.
- **M2. It is concentrated.** 1,223 distinct files; the top 20 hold 44% of file-read tokens. One
  file, `sites/all/modules/activit/d_inspection.inc` in one Drupal 7 project (12,797 lines, 712 KB),
  holds ~19% (~57M of ~307M weighted tokens), read ~1,400 times in 26 tasks, all on copies of that
  project: 18 on repositories since deleted, the rest on copies named for a model-comparison series.
  Repetition inflates the figure.
- **M3. Agents read through the shell.** `cat`/`sed -n`/`head`/`tail` results are 58% of tool-result
  tokens, claude's `Read` tool 9.4%, shell search 13.8%, the `haive-rag` MCP server 2.8%. Haive sees none of M1-M3 today:
  `tool_usage` (`cli-executor/tool-usage.ts`) counts calls by tool name, recognises a path only when
  it opens an agent or skill definition (`classifyReadPath`), and is fed `tool_use` blocks only,
  never tool results.
- **M4. Haive's own development sessions are flat.** Over 1,362 Claude Code transcripts (53.6B exact
  prompt tokens), file content is 10.4% of prompt tokens, and the most-read file, `step-runner.ts`
  (5,148 lines), is 1.8% of file-read tokens, about 0.19% of all prompt tokens. The first
  measurement that ignored compactions gave an impossible 231%; one session had 82.
- **M5. Usage of a killed run is wrong.** 16 runs show tool results above 100% of their recorded
  prompt tokens. The 7 claude-code ones all exited 137 with no `result` event, and their usage came
  from the live fallback in `queues/cli-exec/stream.ts`. Of the 25 claude-family runs with no
  `result` event (24 exited 137, one has no exit code), 22 record cache reads as one turn's value (`assistantCacheReadMax`: 2.84M stored
  against 83.7M summed per message) and cache writes about doubled (5.73M against 2.52M), because
  the fallback sums per stream event and one message spans several events. On finished runs the
  CLI's own `result` usage equals the per-message sum exactly (checked on e647071c, 05f88cc1,
  1fd709ca). The 9 grok runs finished normally; their cause was not investigated.
- **M6. The article's price does not transfer.** Cache reads are 73.4% of all tokens on the install
  (`docs/architecture/statistics.md`), so re-sent file content is mostly billed at the cache-read
  rate. Haive's per-invocation `cost` snapshot is the figure to compare, never tokens × the
  uncached price.

## Phases

### P0. Record what each run read

**Goal.** Per invocation: which repository files the agent read, how much, and how long each stayed
in context. Per repository: the files that cost the most, and which steps pay for them.

- **One tally.** Extend `createToolUsageTally`, the pure module the live collectors and the boot
  backfill both feed, so a live record and a backfilled one cannot disagree. New feed points:
  `tool_result` blocks of claude-family `user` events (size, keyed by `tool_use_id`), assistant
  message ids (turns, deduplicated by id), `compact_boundary` (a result's life ends), and codex
  `command_execution` items, which carry the command and its output in one item.
- **Paths.** The read tool's input keys (`CLI_TOOL_NAMES.readTools`), and `commandPathTokens` on
  reader commands only (`cat`, `sed -n`, `head`, `tail`, `nl`), with redirect targets such as
  `2>/dev/null` excluded. Normalised as `classifyReadPath` already does: the sandbox mount root and
  `.haive/worktrees/<name>` stripped. A path outside the repository (a CLI's own temp file) goes to
  one `outside` bucket, never dropped silently.
- **Record.** A new `reads` key in `tool_usage`: per file `{ path, reads, chars, weightedChars }`,
  totals for all results and for file reads, `turns`, `compactions`, and `resultSeen` (whether the
  transcript held the CLI's `result` event). `weightedChars` is chars × later turns before the next
  compaction; where turns cannot be observed it is null, never 0. The file list is capped (D1) with
  an `omitted` count, so one runaway run cannot bloat the row. `InvocationToolUsage` and its mirror
  type in `@haive/database` change together. jsonb needs no SQL migration.
- **Backfill.** The boot backfill selects `tool_usage IS NULL`, so it never revisits the 3,542
  rows on the dev install that already have a record. Add a convergent pass on the missing key
  (`NOT (tool_usage ? 'reads')`), with the same time budget and batch size, writing `reads: null`
  where nothing is observable so it converges. An elided transcript (4 MiB head+tail cap) gives
  floors, as `coverage: 'partial'` already means.
- **Statistics.** A "Files read" section on the existing lazy tool-usage tab
  (`/m/statistics/tool-usage`), which already pays for `tool_usage` rows. Per repository (the repo
  facet), ranked by weighted tokens: path, reads, runs, tasks, estimated weighted tokens, and share
  of the repository's file-read tokens, plus each step's file-read share of its prompt tokens. A
  share's denominator is exact `token_usage` and counts only runs with `resultSeen` (M5). The
  estimate is labelled as characters / 4 beside the exact totals. `RankedBars`, n on every row,
  `n=` under `MIN_SAMPLES_FOR_TREND`, a dash where nothing is observable.

**Check.**
- Tally unit tests: a whole and a ranged read, a `sed -n` and a `cat` chain, a redirect that is not a
  path, a worktree path, an outside path, a compaction ending a result's life, a codex
  `command_execution` with output, an elided transcript.
- A backfill test: a row with `tool_usage` but no `reads` converges in one pass, and a second pass
  finds nothing.
- On the dev install, the backfilled totals reproduce M1-M3 to within a few percent of
  `.claude/tmp/read-cost/read-cost.out`; any difference is explained or fixed.
- Rollup unit test, route test, and a browser check of the section at desktop, tablet and phone
  widths, logged in, with real rows.

**Rollback.** Additive: a jsonb key, tally feeds, a backfill pass and a statistics section. Revert
the commits; rows keep a `reads` key that nothing reads. No migration.

### P1. Measure a refactor by replay

**Goal.** The article's protocol, with Haive's exact usage instead of characters / 4: what the same
change costs before and after a refactor.

- **The change.** A past invocation that read the hotspot heavily, picked from P0: its stored prompt
  (`cli_invocations.prompt` holds `plan.effectivePrompt`, what was dispatched), CLI, served model
  (`model_identity`) and effort. A real change on that repository, not a synthetic prompt.
- **The runs.** That prompt in a fresh sandbox on two trees: A, the commit the original run saw, and
  B, the refactored commit. Each is a throwaway checkout that carries the original task's `.haive/`
  inputs the prompt names. Nothing is committed or pushed, and the checkouts are removed. At least
  three runs per tree, each on its own copy.
- **What is read.** Per run: `token_usage`, `cost`, P0's `reads`, turns, wall time, and whether the
  change was completed, judged by the repository's verify commands as 08 resolves them. A run that
  fails its checks is a failure with evidence; one that could not run is unknown, never a failure.
- **Decision rule, written before the run.** B qualifies when its completion rate is at least A's.
  Only then is cost compared: median prompt tokens and `cost` per completed change.
- **Size it first.** Every replay is a full agent run: runs × the source step's median `cost` from
  statistics, stated before running.
- Starts as a script run on the dev install, with no product surface (D3). It shares its machinery
  with `parsimony-lessons` P3, which replays one task with another model where this replays it on
  another tree (D2).

**Check.** One replay pair on a fixture repository with a deliberately split file: both arms
recorded, medians and spread reported. A dry run proves nothing is committed or pushed and every
checkout is removed. Before the first real replay, a zero-token recorder run confirms the stored
prompt is what the CLI receives after the adapter adds the MCP surface and the global-KB digest.

**Rollback.** Replays run in throwaway checkouts and write only their own output; nothing in the
live workflow reads them. Delete the script and its output.

### P2. A refactor task type for read cost (parked)

**Reopen when** P0 shows, on a live repository (not a benchmark copy), a file holding at least 10%
of that repository's file-read tokens across at least five tasks in 30 days.

- An admin-composed task type (`docs/architecture/task-types.md`): prompt-template steps are data
  and need no rebuild.
- Input: one hotspot file from P0's view.
- Steps: an analysis agent proposes an ordered refactor plan under the article's rules (remove
  duplication before splitting; split by domain so the code one change needs sits in one small
  file, never by size alone; keep tests beside their modules; behaviour unchanged and tests green
  after every step; one refactoring per commit). A human gate approves or edits the plan, because
  the article's agent chose refactorings poorly and missed the most valuable one. Then the steps
  are implemented one at a time with verification after each, and the usual review runs.
- The acceptance number is P1's replay, before and after.
- Not built until P3 has run the same rules by hand once.

**Rollback.** One task-type row: disable it, or delete it while no task uses it.

### P3. First use: `d_inspection.inc`

The owner's decision (D4): the file is the user's client code.

- If yes: an ordinary workflow task on that repository, with P2's rules in the task description and
  no new type. Measured with P1, replaying a past invocation from M2.
- It settles whether the article's result holds on a real Haive repository, and its outcome is the
  evidence P2's reopen needs.
- Read P0's per-repository view first: M2 is inflated by benchmark copies, and the live repository's
  own figure decides whether the refactor is worth it.

**Rollback.** An ordinary workflow task; its commit reverts like any other.

## Not taken

- **Splitting Haive's own large files to save tokens.** M4: the ceiling is a fraction of a percent
  per file.
- **The article's dollar figure** (M6).
- **Characters / 4 as the token measure where exact usage exists.** P0 uses characters only to split
  a run's exact total between files.
- **A "file too large" review finding.** M2 rests on one file in one project; nothing shows size
  alone predicts read cost. P0's data first.

## Not verified

- Whether claude-code clears old tool results without logging a compaction. If it does, the
  weighted figures overstate.
- Paths parsed from shell commands are a heuristic, so per-file figures are floors. Codex reads
  were counted in totals but not attributed to files.
- Why 9 grok runs show results above their recorded prompt tokens (M5).
- The article was read through a summarising fetch of its page, not verbatim. Its per-step numbers
  are as reported there.

## Open decisions

- **D1.** P0's file-list cap per run, and whether the task page's usage panel also lists a run's
  files.
- **D2.** One replay harness for P1 and `parsimony-lessons` P3, varying the tree or the model.
- **D3.** P1 as a dev-install script only, or a product surface later.
- **D4.** Whether to refactor `d_inspection.inc` at all (P3).

## Decided

Nothing yet.

## Found, not fixed

- **Killed runs record wrong token usage** (M5). PRE-EXISTING, in `queues/cli-exec/stream.ts`
  (`getTokenUsage` fallback): cache reads as the largest single turn, other buckets summed per
  stream event. The remedy is to sum the four buckets once per `message.id`, as the CLI's own
  `result` does. It is its own PR, outside this plan: P0 does not wait for it, since its shares
  count only `resultSeen` runs. Stored rows are not rewritten, because `cost` is an immutable
  snapshot.

## Relation to other plans

- `parsimony-lessons`: P3's same-task replay is P1's harness (D2). Its change-size counter (P0
  there) can show whether a refactor kept code size flat, which is the article's "same code, read
  less".
- `rag-retrieval-improvements`: P0's per-run file-read share could serve as an outcome measure for
  retrieval changes, since better retrieval should mean less reading.
