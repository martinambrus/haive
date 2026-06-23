# Haive benchmarks

## Onboarding LLM comparison

`onboarding-llm-comparison.html` — interactive, self-contained report comparing 10 LLMs that each auto-onboarded the same legacy repository through Haive's step engine. Open it directly in a browser (no build step, no external dependencies, works offline).

It covers two dimensions:

1. **Correctness** — stack detection, knowledge base, skills, discovered agents, and global-KB promotion, each audited against the real source code.
2. **Cost** — CLI compute time and output tokens (raw input/total token counts are not comparable across providers; see the in-page methodology note).

Features: heat-mapped sortable leaderboard, a quality-vs-speed scatter plot, best-LLM-per-step table, expandable per-model detail cards, and the notable-defects list.

### Onboarded project

[Redaction System](https://sourceforge.net/projects/redactionsystem/) — a legacy PHP content-management / page-"redaction" CMS (circa 2008): deprecated `mysql_*` extension, MySQL/MariaDB, FCKeditor, YUI, jQuery, no framework.

### Regenerating

The data array is inlined at the top of the `<script>` block in the HTML. Source data was pulled from the Haive DB (`tasks`, `task_steps`, `cli_invocations`), each repo's on-disk `.claude/` artifacts, and the `haive_kb_global` DB; quality scores came from a structured multi-agent audit. Edit the `DATA` array to refresh.
