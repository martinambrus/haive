# Haive benchmarks

## Onboarding LLM comparisons

Both reports are interactive, self-contained HTML files. Open either directly in a browser; they have no build step or runtime dependencies.

- `onboarding-llm-comparison.html` - historical 23 June 2026 benchmark of 11 LLM runs.
- `onboarding-llm-comparison-2026-07-10.html` - fresh 10 July 2026 benchmark of six runs after the pipeline update: five returning models plus OpenAI Codex. It also includes a same-model June/July table, with the pipeline-change caveat stated in the report.

It covers two dimensions:

1. **Correctness** — stack detection, knowledge base, skills, discovered agents, and global-KB promotion, each audited against the real source code.
2. **Cost** — CLI compute time and output tokens (raw input/total token counts are not comparable across providers; see the in-page methodology note).

Features: heat-mapped sortable leaderboard, quality-vs-speed scatter plot, best-LLM-per-step table, expandable evidence cards, notable defects, methodology, and run provenance. The July report adds a historical comparison.

### Onboarded project

[Redaction System](https://sourceforge.net/projects/redactionsystem/) — a legacy PHP content-management / page-"redaction" CMS (circa 2008): deprecated `mysql_*` extension, MySQL, FCKeditor, YUI, jQuery, no framework. MariaDB 10.11 in the run metadata is the benchmark harness, not the source application's declared target.

### Regenerating

The data arrays are inlined in each HTML file. Source data comes from the Haive DB (`tasks`, `task_steps`, `cli_invocations`), each repo's on-disk `.claude/` artifacts, and the separate `haive_kb_global` DB. Quality scores come from a structured, source-verified multi-agent audit. Edit the relevant `DATA` array to refresh.

The published composite is `KB 25% + Skills 25% + Detection 20% + Agents 15% + Global KB 15%`. Cost uses all CLI invocations, including superseded retries, so a rerun pays for failed attempts instead of hiding them.
