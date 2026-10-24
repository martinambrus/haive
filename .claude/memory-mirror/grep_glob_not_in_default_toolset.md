---
name: grep-glob-not-in-default-toolset
description: Grep and Glob are absent from this Claude Code build's default toolset; they work but cannot be added back without replacing the whole set
metadata:
  type: reference
---

Since roughly v2.1.241 -> v2.1.270, `Grep` and `Glob` are not in the default session toolset on this install. Last real calls: 2026-08-30/31 on 2.1.241; zero in every transcript from 2.1.270 onward.

NOT a local problem, all four ruled out by probe on 2.1.278: not settings (no `disabledBuiltinTools` or `builtinToolPolicy` anywhere, and a settings-free config dir also lacks them), not a model gate (haiku-4.5 lacks them too), not cwd-scoped (/tmp lacks them), not bypass-permissions mode (probes ran in default mode). `ToolSearch select:Grep,Glob` answers "No matching deferred tools found", so they are not deferred either. No release note retires them, and the changelog still carries a FIX for them ("Grep, Glob and @-file suggestions hanging ... over the 20MB output cap"), so they are maintained, just not offered.

They exist and can be named: `--tools "Read,Bash,Grep,Glob"` yields exactly those four. But `--tools` REPLACES the set rather than extending it — `--tools "default,Grep,Glob"` yields only `["Glob","Grep"]`, and `--tools default` alone still excludes them. So there is no additive lever and no worthwhile local fix.

Practical impact is low: Bash (`/usr/bin/grep`, rg) covers it, the Explore agent covers fan-out search, and bypass-permissions mode instructs Bash-first anyway. See [[rtk-grep-is-rg]] — rg treats `{{` as a regex error and reports "0 matches".

Related: [[todo-tools-model-gated]] (same install, found in the same investigation, but a DIFFERENT cause — that one is a model gate with an env-var fix).
