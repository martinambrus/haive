---
name: literal-nul-makes-source-binary
description: A literal control character written into a source file makes grep/ripgrep skip it silently; write the escape sequence instead
metadata:
  type: feedback
---

Never write a literal control character (NUL especially) into a source file. Write the
language's escape sequence — `\u0000` in TS/JS — which is the same string at runtime and
keeps the file text.

**Why:** on 2026-09-05 I emitted a raw NUL as a composite-key separator in
`packages/shared/src/rag/search.ts`. It typechecked, all tests passed, and it shipped. But
`file` then classified the module as `data`, so **`grep -r` and ripgrep silently SKIPPED the
whole file** — every recursive search in the repo missed it and said nothing. Found only
because a subagent noticed its own greps came up empty and re-ran with `grep -a`. Fixed in
`50f854a`.

**This recurs in my own output path.** Twice more the same turn: a commit message carrying the
raw byte was rejected ("contains control characters"), and the first draft of THIS memory file
landed with 2 NULs and `file` reporting `data`. Typing the escape in prose is what emits the
byte.

**How to apply:** build such keys with `[a, b, c].join(...)` rather than embedding the
character in a template literal. Write commit messages to a file and use `git commit -F`. When
a file must contain the escape text, write it with a generator that concatenates a backslash
to `u0000` instead of typing it. Then verify: `file <path>` must still say "text", and
`tr -cd '\000' < file | wc -c` must print 0.

Related: [[haive-pr-workflow]].
