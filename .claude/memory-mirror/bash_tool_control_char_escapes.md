---
name: bash-tool-control-char-escapes
description: 'A Bash command whose text carries escapes for hidden control characters is refused before anything runs, even inside a quoted heredoc; build those characters at runtime instead'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-09-23T11:22:01.923Z
---

The Bash tool refused a whole command with `InputValidationError: command contains control
characters that would be hidden in the approval dialog`. The command wrote a node script through a
quoted heredoc, and the script spelled vertical-tab, form-feed and DEL as JavaScript backslash-u
escapes. Nothing ran. It happened a SECOND time from a command that merely quoted those escapes
inside a memory note, so the check reads the command text itself and a quoted heredoc does not
shield it. Earlier commands with backslash-t, backslash-n and the backslash-u escape for NBSP
passed, so the trigger is an escape for a character a dialog cannot show, not backslashes in
general.

**Why:** the approval dialog cannot display those characters, so the tool rejects the command
rather than let an invisible byte through.

**The Edit and Write tools DECODE a backslash-u escape instead of writing it.** MEASURED
2026-09-23: a regex character class written through Edit as backslash-u 2028 and backslash-u 2029
landed in `expand-archives.ts` as the LITERAL line-separator characters. They ended the regex
literal (tsc: "Unterminated regular expression literal"). A test string written the same way got an
invisible literal U+2028 that passed its tests and would have gone to review unseen. Backslash-r and
backslash-n in the same class stayed as text. So after writing ANY backslash-u escape through
Edit/Write, scan the file for literal U+2028/U+2029/C0/C1 characters and replace each one with its
escape text by a script (a Python replace of the character with a backslash plus `u2028`).

**How to apply:** construct such characters at runtime and keep the command text plain ASCII —
`String.fromCharCode(11)` for VT, `String.fromCharCode(0xa0)` for NBSP, and
`String.fromCharCode(92) + 'u'` when output needs a literal backslash-u. When DOCUMENTING the
problem, describe the escape in words rather than writing it. Same family as
[[literal-nul-makes-source-binary]]: write code that builds the character, never the character or
its escape where a tool inspects the text.
