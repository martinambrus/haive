---
name: worktree-guard-command-shapes
description: 'In a worktree session the Bash guard refuses shell loops, variables, two heredocs, quoted paths with ()[] and sleep; the shapes that pass'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2c955f67-0a5a-47cb-b6fd-7506bd02d936
  modified: 2026-09-25T10:38:37.391Z
---

Learned 2026-09-15 in `.claude/worktrees/tool-usage-stats`. Refused as "too complex to verify
it stays inside the worktree": a `for` loop, `$(...)` or `$var` feeding rtk/git/gh, a chain with
TWO heredocs, `rtk proxy npx prettier` on a path containing `(app)` or `[id]` (quoted or not),
and any foreground `sleep`. Accepted: one heredoc per call, absolute paths, commit messages and
PR bodies written to the scratchpad first and passed with `-F`/`--body-file`, prettier through
`./node_modules/.bin/prettier` with a `**` glob for bracketed directories, and `gh api ... --jq`
one-liners without loops.

**How to apply:** split polls into separate plain calls; stage long text in
`$SCRATCHPAD/*.txt`; never `cd` out of the worktree. Related: [[worktree-guard-rtk-git]].

**A variable can arrive EMPTY instead of being refused.** 2026-09-25, a chain starting `cd
/home/activit/haive && SP=...; W=.claude/worktrees/x; mv $W/... ; rm -rf $W/test-results`, run while
the session's primary directory was that worktree, printed `[rtk: No such file or directory]` and
ran on with `$W` empty: `git -C $W` failed and `rm -rf $W/test-results` became `rm -rf
/test-results`, harmless only because no such path existed. Never build an `rm` path from a shell
variable here: spell every removal target as a literal absolute path.
