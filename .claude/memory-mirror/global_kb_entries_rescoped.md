---
name: global-kb-entries-rescoped
description: Six promoted global-KB drafts were re-scoped through the API on 2026-09-15 at the user's request; which ones, why some were left alone, and how to undo it
metadata:
  type: project
---

On 2026-09-15 the user asked me to re-scope the existing global KB entries instead of doing it by
hand (it had been theirs to do). Done through `PATCH /global-kb/entries/:id`, never SQL, after
reading every body. Rule applied: base technology unless the content is genuinely
version-specific; where a version was dropped, the title and the body's first `# ` heading were
renamed to match, and nothing else in any body changed.

| entry      | was                                           | now                                                                 |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `f526104d` | PHP 8 Best Practices · php + phpMajor 8       | PHP Best Practices · php                                            |
| `f14a336d` | PHP 8 Mistakes · php + 8                      | PHP Mistakes · php                                                  |
| `3c9a07ee` | PostgreSQL 17 Best Practices · postgres + 17  | PostgreSQL Best Practices · postgres                                |
| `dd3dff0c` | PostgreSQL 17 Mistakes · postgres + 17        | PostgreSQL Mistakes · postgres                                      |
| `ceba7217` | PostgreSQL 17 Quick Reference · postgres + 17 | PostgreSQL Quick Reference · postgres                               |
| `1f6f5558` | PostgreSQL 17 Quick Reference · postgres      | PostgreSQL Quick Reference for Drupal · postgres + framework drupal |

All six are still drafts. Deliberately left alone — do not "finish the job" on these:

- `801ba9db` "PHP 8 Value and Comparison Pitfalls" keeps php 8: its core section is PHP 8's changed
  number/string comparison.
- `42ac658a` "no inline svgs" is the user's own entry, scoped `framework: drupal` by them.
- `317ab83c`, `f853c40b`, `5e684095` are benchmark data awaiting purge, see [[global-kb-purge-pending]].

`1f6f5558` got `framework: drupal` because its content is Drupal-specific (Schema API type map,
`watchdog` bytea search), so its topic key became `quick_reference:drupal`.

Side effect, by design of the re-scope link rule: two supersede proposals were cleared,
`801ba9db → f14a336d` and `3c9a07ee → 5e684095`. The API cannot restore a link.

**Rollback:** PATCH each entry back to the "was" title and facets, with the body's first `# `
heading set back to the old title. That is the whole difference.

**Side effect on the in-flight TASK-185 re-test runs (found after the fact).** The drafts came from
parked onboarding runs: `f526104d`, `f14a336d`, `3c9a07ee`, `dd3dff0c`, `ceba7217` from 603cf7f6
(codex_sol), `801ba9db` from e33d3c4b (astra), `1f6f5558` from 2e49fa91 (grok).
`09_6_4-global-kb-merge` pairs a run's OWN drafts (by `source_task_id`) with the entry each supersedes,
so the two cleared links each remove one merge pair: codex_sol's `3c9a07ee → 5e684095` (a benchmark
entry, see [[global-kb-purge-pending]]) and astra's `801ba9db → f14a336d`. The renamed titles and
headings also change what 09_6_5 shows those runs. Restoring a link needs SQL on a real row, since the
API cannot set one, so it needs the user's explicit OK.
