# QA reviewer-CLI benchmark: the persona x CLI matrix, and making validation measurable

> Status: FINDINGS (part 1), 2026-08-25. Part 2 (verifier attribution) IMPLEMENTED 2026-08-25. Durable record so the data
> survives to the xhigh re-run (~2026-09-01, once Codex allowance resets; ideally after OpenAI
> Cyber access lands so gpt-5.6-sol stops being moderation-refused). Codex effort tasks: medium
> `634de4a7` (cancelled, clean), high `3921a515` (cancelled, moderation-refused), xhigh
> `da30c662` (CONTINUING 2026-08-25 after Codex allowance reset; app is broken from a forced 07c
> accept, so its 08d reproduction is confounded but its finding counts + the FIRST validation-lens
> data are usable).

## Part 1 - What the data says (the matrix)

### Metric and its limits

The confound-surviving metric is REPRODUCTION RATE: of the findings a reviewer raised at 08d, the
fraction a PoC verifier could actually reproduce. It measures finding QUALITY independent of how
buggy the reviewed code happened to be; raw finding COUNTS do not survive that confound and are used
only as a volume/character signal. Samples are SMALL (most cells 3-12 verified findings, several
n=1) - this is early signal, not a settled ranking. Thousands of historical findings have no
provider attribution and are excluded.

### Aggregate reproduction rate by reviewing CLI (08d adversaries)

| CLI | reproduced / not | rate | character |
|---|---|---|---|
| claude-code | 20 / 4 | 83% | high signal, real findings |
| ollama | 35 / 10 | 78% | thorough; high volume of real-but-minor |
| zai | 9 / 3 | 75% | conservative, solid |
| grok | 1 / 6 | 14% | ALARMIST - most high-sev claims do not reproduce |
| codex | 1 / 1 | 50% (n=2) | absent by REFUSAL, not weakness (moderation gate) |

Severity cross-check: grok raised the MOST high-severity findings (13) at 14% reproduction - it
manufactures scary "blocking" claims that evaporate under verification. It only survives because
08d verification is fail-closed (unanimity to dismiss). claude-code/ollama/zai raise findings that
mostly hold up.

### Persona x CLI reproduction matrix (rate, with repro/not sample)

| persona | claude-code | ollama | zai | grok | codex |
|---|---|---|---|---|---|
| auth-bandit | 100% (3/0) | 100% (4/0) | - | - | - |
| chaos-creator | 80% (4/1) | 70% (7/3) | 100% (4/0) | 0% (0/2) | - |
| edge-case-breaker | 100% (5/0) | 78% (7/2) | 50% (1/1) | 100% (1/0)* | 50% (1/1) |
| injection-infector | 40% (2/3) | 100% (1/0)* | 0% (0/1) | 0% (0/2) | - |
| logic-lunatic | 100% (3/0) | 83% (10/2) | 67% (2/1) | 0% (0/1) | - |

`*` = n=1, noise.

### Best CLI per adversary seat (with confidence)

- **auth-bandit -> claude-code or ollama.** Both perfect on small samples (3-4). Genuine tie.
- **chaos-creator -> zai.** 100% (4/0), beats claude-code's 80%; grok actively bad (0/2).
- **edge-case-breaker -> claude-code.** 100% (5/0), the best sample-backed cell here. ollama
  (78% / 9) is the thoroughness alternative.
- **injection-infector -> no winner.** Everyone reproduced poorly (claude-code 40%, zai 0%,
  grok 0%; ollama's "100%" is n=1). Either these findings are hard to PoC-verify or the persona
  needs rework. FLAG for more rounds; do not pick a winner on this data.
- **logic-lunatic -> ollama (volume) or claude-code (rate).** ollama 83% on 12 is stronger
  evidence than claude-code 100% on 3.

### Pattern

claude-code is the reliable all-rounder (100% on three of five personas); ollama is the volume
workhorse (good rates at the highest counts); zai spikes on chaos-creator; grok is worthless
wherever it has a real sample; codex is blank because it was refused/rate-limited, NOT because it
reviewed badly.

### Reliability findings this run added (beyond the historical data)

- **The moderation gate is a first-class reliability variable.** codex/gpt-5.6-sol REFUSED high's
  08d (3 seats, both attempts, `provider_fatal_class = content_filter`) and RATE-LIMITED xhigh at
  08c2 (`rate_limit`) before it reached 08d. Intermittent - medium got through clean. For security
  QA, "which CLI is best" must include "which CLI will actually run the review", and codex answers
  that unreliably without Cyber access.
- **Anthropic's gate behaves differently:** it SILENTLY SWAPS the served model (fable-5 ->
  opus-4-8) on a security prompt rather than refusing - exit 0, no error, only
  `model_identity.match = 'differs'` catches it. See [[project_anthropic_gate_model_swap]].
- **Effort may interact with the gate** (n=3, hypothesis only): medium (medium effort) passed;
  high and xhigh (higher effort) hit the gate. The re-run is what tests this cleanly.

## Part 2 - Follow-up: make the VALIDATION half measurable (before the re-run)

### The gap

The persona matrix above covers only the ADVERSARIES (who raise findings). The VALIDATION lenses
(the 3 qa-verify seats that decide reproduced/not) cannot be scored today: the verdict is persisted
as a bare consensus STRING (`review_findings.raw->>'verification'`), with no record of which
verifier CLI produced it. So there is no lens x CLI matrix, and no way to answer "which CLI to set
on each verifier seat".

### Why it is a small change

The per-lens data already exists at collapse time. Each verify lens runs as its own mining seat
keyed by `verifierAgentId(groupKey, lens, attempt)` (08d-adversarial-qa.ts:287), and
`miningInvocationId(results, agentId)` (mining-failure.ts) already returns that seat's
`cli_invocation_id`. `verificationForFinding` (08d-adversarial-qa.ts:~526) has all lens verdicts in
hand when it collapses them to the consensus. Nothing new needs to be computed - only PERSISTED.

### The change

At the 08d record site, alongside the collapsed `verification` string, persist the PER-LENS panel:
each lens's `{ lensId, cliInvocationId, verdict, observation? }`. Two storage options:

- **Lightest:** a `raw.verifications[]` jsonb array on the finding (review_findings is write-only
  telemetry; this rides the existing best-effort insert, never throws).
- **Cleaner to query:** a sibling `review_finding_verifications` table (findingId, lensId,
  cliInvocationId, verdict, observation), joinable to cli_providers like the adversary matrix.

IMPLEMENTED as jsonb-in-`raw`, NOT the sibling table, after reading the code: `recordReviewFindings`
bulk-inserts findings with no `.returning()` and with `onConflictDoNothing`, so a FK sibling table
would need painful id-threading (and skipped-on-conflict rows have no id at all). The finding's
`raw` already carries the `verification` string for free, so a `verifications` array rides the same
insert with zero new plumbing. `verifierPanelDetail()` (08d-adversarial-qa.ts) records, per lens,
`{ lensId, cliInvocationId, verdict }` - capturing the seat's CLI even when the verdict is null, so
a silent verifier is not invisible. The GROUP BY is slightly more verbose but works:

```sql
select v->>'lensId' lens, cp.name::text cli,
  count(*) filter (where v->>'verdict'='reproduced') repro,
  count(*) filter (where v->>'verdict'='not_reproduced') notrepro,
  count(*) filter (where v->>'verdict'='could_not_test') cnt
from review_findings rf, jsonb_array_elements(rf.raw->'verifications') v
left join cli_invocations ci on ci.id = (v->>'cliInvocationId')::uuid
left join cli_providers cp on cp.id = ci.cli_provider_id
where rf.step_id = '08d-adversarial-qa' group by 1,2 order by 1,2;
```

### The metrics it unlocks (verifier quality proxies - no absolute ground truth exists)

Verifier "correctness" has no oracle (the panel consensus IS the current best truth), so measure
proxies per verifier CLI:

- **Agreement with the panel consensus** - a lens that constantly dissents is either a
  false-negative machine or a valuable skeptic; the rate tells you which to investigate.
- **`could_not_test` rate** - a verifier that gives up a lot is less useful (this is exactly the
  PoC-verifier precondition blind spot: a broken app makes everything untestable - see
  [[project_poc_verifier_precondition_blindspot]]).
- **Observation-provision rate** - a verifier that reports `reproduced:false` WITHOUT an
  observation is not trusted by the collapse rule anyway; measuring it flags weak verifier CLIs.

### Ordering and rollback

Additive: new table (idempotent numbered migration) + a persist call at the collapse site. Ship it
BEFORE the xhigh re-run so the next round produces the validation half of the matrix. `git revert`
restores today's behaviour; nothing reads the new table until a query does. No behaviour change to
the verdict itself - the consensus string stays authoritative.

### Re-run conditions

Retry xhigh (and ideally re-run high clean) when: (1) Codex allowance has reset, and (2) OpenAI
Cyber access has landed so gpt-5.6-sol stops being moderation-refused on security prompts. That is
the one comparison this run could not deliver - a clean three-way effort matrix AND, with part 2
shipped, the first validation-lens x CLI data.
