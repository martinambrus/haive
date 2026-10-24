---
name: house-rules-pr8-resume
description: 'House-rules PR8 (similarity on, with per-rule floors) is parked on data; how to tell when enough has accumulated, and the constraints the resumed PR must keep'
metadata:
  node_type: memory
  type: project
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-11T13:49:22.044Z
---

**PR8 = switch house-rules similarity from `record` to on, with a PER-RULE floor measured from graded data.**
PR7b (2026-10) records a similarity score for each enforced `files` rule that a writer dispatch did not
already select by path. The score is stored in `cli_invocations.house_rules->'similarity'` as
`{status, errorClass?, model?, queryHash?, ms?, scores:[{id, hash, title, score|null, stale?}]}`
(`houseRulesSimilaritySchema`, packages/shared/src/global-kb/house-rules.ts). The prompt never sees it.
Plan: `abstract-splashing-owl` (PR7/PR8 sections). Series history: [[house-rules-series]].

**Why it is parked:** one live probe showed that similarity separates only tasks that NAME the rule's
topic. The task scored 0.469 against its own rule and 0.404 against an unrelated rule. An invites-only
spinner task scored 0.284 against its rule, lower than the 0.314 it got against an unrelated one. A single
global floor would be wrong, so each rule needs its own floor, set from graded runs.

**PREREQUISITE, or nothing ever accumulates:** at least one global-KB entry must be ENFORCED with mode
`files` (admin, the entry's Enforce panel). Scoring runs only over enforced `files` rules.

- Measured 2026-10-11 on the dev install: 10 entries, 0 enforced, so 0 similarity records.
- The config `config:globalKb:houseRulesSimilarity` = `record` (the default; `off` stops it).
- Which rules to enforce is the USER's call. Never enforce one to make data appear; ask.

**Resume check.** Run it when a workflow task's `07` (implementation) lands, since writer steps are
what get scored. Read-only:

```sql
select count(*) as runs, count(distinct task_id) as tasks
from cli_invocations
where house_rules->'similarity'->>'status' = 'ok'
  and exists (select 1 from jsonb_array_elements(house_rules->'similarity'->'scores') s
              where s->>'score' is not null and coalesce((s->>'stale')::boolean, false) = false);
```

**Resume when `runs >= 10`, spread over several tasks and several rules.** Baseline 2026-10-11: 0 / 0.
Then reopen PR8:

- grade each recorded `{task, rule, score}` as relevant or not;
- derive one floor per rule;
- switch the mode on.

**Constraints the resumed PR8 must keep** (from the PR #486 review):

- Global-KB vectors carry no model provenance until #56 lands. Exclude records made across an
  embedding-model change: compare `similarity.model` with the model the rule's vectors were built with,
  or with the time of the last model change.
- Exclude `failed` records (`unknown_provenance`, `abandoned`, `timeout`, …) and `stale` scores from grading.
