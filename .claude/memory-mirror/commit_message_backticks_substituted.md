---
name: commit-message-backticks-substituted
description: git commit -m with backticks in a double-quoted bash string silently runs them as commands and drops the word
metadata:
  node_type: memory
  type: feedback
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-20T18:33:04.625Z
---

`git commit -m "... \`proven\` is tested first ..."`inside a double-quoted bash string performs
COMMAND SUBSTITUTION on the backticks. The shell prints`proven: command not found`to stderr,
the commit still succeeds, and the word is silently deleted from the message — leaving prose like
"Testing the stamp before  therefore swallowed the case". MEASURED 2026-09-20 on commit`06609bb5`, where it damaged two sentences.

**Why:** commit messages in this repo carry the reasoning, so a missing identifier changes what
the message means. It is not caught by the commit hook, and by the time it is noticed the commit
is usually pushed — where repairing it costs a force-push that changes the sha, restarts CI and
invalidates review anchors, which is rarely worth a cosmetic fix.

**How to apply:** write any commit message that names code in a scratchpad file and use
`git commit -F <file>`, the same way PR replies are already written. Reserve `-m` for short
messages with no backticks. See [[haive-pr-workflow]].
