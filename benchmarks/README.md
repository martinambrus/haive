# Haive benchmarks

## Onboarding LLM comparisons

All three reports are interactive, self-contained HTML files. Open any directly in a browser; they have no build step or runtime dependencies.

- `onboarding-llm-comparison.html` - historical 23 June 2026 benchmark of 11 LLM runs.
- `onboarding-llm-comparison-2026-07-10.html` - 10 July 2026 benchmark of six runs after the pipeline update: five returning models plus OpenAI Codex. It also includes a same-model June/July comparison broken out by dimension (per-dimension score deltas plus artifact-volume and cost deltas), with the pipeline-change caveat stated in the report.
- `onboarding-llm-comparison-2026-07-14.html` - 11-14 July 2026 benchmark of 36 runs adding two axes the earlier reports never covered: reasoning effort (low / medium / high / xhigh / max, plus ultra where the CLI offers it) swept within a model, and model variant within one CLI provider (the claude-code CLI run as Opus 4.8, Sonnet 5, Sonnet 4.6, Haiku 4.5 and Fable 5; OpenAI Codex as gpt-5.5 and gpt-5.6-sol; GLM-5.2 via z.ai). Adds an effort-curve scatter, per-family effort-sweep tables, a matched-effort model-variant table, and a cross-period continuity view against the June and July-10 baselines (carried forward unchanged). Same source-verified five-dimension audit; the pipeline+provider-shift caveat is stated in the report.

It covers two dimensions:

1. **Correctness** — stack detection, knowledge base, skills, discovered agents, and global-KB promotion, each audited against the real source code.
2. **Cost** — CLI compute time and output tokens (raw input/total token counts are not comparable across providers; see the in-page methodology note).

Features: heat-mapped sortable leaderboard, quality-vs-speed scatter plot, best-LLM-per-step table, expandable evidence cards, notable defects, methodology, and run provenance. The July reports add cross-period comparisons; the 14 July report adds effort-curve and effort-sweep views.

### Onboarded project

[Redaction System](https://sourceforge.net/projects/redactionsystem/) — a legacy PHP content-management / page-"redaction" CMS (circa 2008): deprecated `mysql_*` extension, MySQL, FCKeditor, YUI, jQuery, no framework. MariaDB 10.11 in the run metadata is the benchmark harness, not the source application's declared target.

### Regenerating

The data arrays are inlined in each HTML file. Source data comes from the Haive DB (`tasks`, `task_steps`, `cli_invocations`), each repo's on-disk `.claude/` artifacts, and the separate `haive_kb_global` DB. Quality scores come from a structured, source-verified multi-agent audit. Edit the relevant `DATA` array to refresh.

The published composite is `KB 25% + Skills 25% + Detection 20% + Agents 15% + Global KB 15%`. Cost uses all CLI invocations, including superseded retries, so a rerun pays for failed attempts instead of hiding them.
