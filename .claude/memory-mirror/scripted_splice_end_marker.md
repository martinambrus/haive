---
name: scripted-splice-end-marker
description: "A python splice whose END marker is a generic token (`\\n};\\n`) can match far past the intended block and delete hundreds of lines; assert on exact old text and check `git diff --stat` right after"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-24T18:28:15.500Z
---

When editing by script, replace an EXACT old string (`assert s.count(old) == 1`), never a span
between `s.index(start)` and a generic end token like `"\n};\n"` or `"\n  );\n"`.

**Why:** 2026-09-24, S11 of the found-not-fixed sweep: the end search for a block that ended in
`);` found the next `};` — the end of the whole step definition — and the splice dropped 997 of
1256 lines of `02-plan-coverage.ts`. It was caught only because the script printed the tail of
the replaced span, and was recoverable only because the file had no uncommitted edits (restored
with `git checkout -- <file>`).

**How to apply:** prefer exact-match replacement. If a span splice is unavoidable, print the
replaced span's length and tail, and run `git diff --stat` immediately; a deletion count far
beyond the edit's size means stop and restore before anything else touches the file. Commit or
copy a file with uncommitted work before splicing it by script.
