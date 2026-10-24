---
name: weekly-usage-not-visible
description: Claude cannot read the subscription's weekly usage in a session; claude-hud gets it from statusline stdin and writes it to a file only when display.externalUsageWritePath is set
metadata:
  type: reference
---

The user asked (2026-10-01) whether Claude can see the subscription's weekly usage the way the
claude-hud statusline plugin does, to pause the series at a threshold (75%). It cannot: claude-hud
0.8.0 reads `rate_limits.seven_day.used_percentage` from the JSON Claude Code pipes to the statusline
command (`dist/stdin.js`), which never reaches a session's tools.

The plugin CAN write that data to a file every 30 s (`dist/external-usage.js`), but only when
`display.externalUsageWritePath` is set in `~/.claude/plugins/claude-hud/config.json`. It was not set
on 2026-10-01, and Claude did not change the user's config. With it set, a session could read the
`seven_day.used_percentage` from that JSON file (no credential involved) and pause at a threshold.

**How to apply:** when the user asks to pause at a usage threshold, check whether that config key is
set; if not, say so and offer it rather than guessing usage. Never read the OAuth credential file to
call the usage API yourself. Related: [[found-not-fixed-sweep-3-series]].
