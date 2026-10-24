---
name: rtk-docker-logs-summarized
description: 'The RTK hook can replace a plain `docker logs <c>` — and a plain `grep` — with a few-line summary, so a piped or parsed read silently finds nothing; the `/usr/bin/` form is always raw'
metadata:
  node_type: memory
  type: feedback
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-25T11:58:16.184Z
---

MEASURED 2026-09-15 (rtk 0.42.4, hook `rtk hook claude`): `docker logs haive-ollama 2>&1 | grep -i
"inference compute"` printed nothing on a container running since 2026-09-08. The line WAS in its
log, since `docker logs --since <boot>` showed it. The plain stream was a summary whose first line
is `[docker] Logs for <name>:`. The same happened on two more long-running containers:
`haive-ddev-registry` gave 22 lines against 130 raw, and `ddev-router` gave 6 against 870.
`/usr/bin/docker logs` returned the full raw log in every case. A freshly recreated
`haive-ollama` (296 lines) came back raw even through the plain command, and so did the
`--tail`/`--since` forms tried, so what triggers the summary was NOT determined. Do not rely on
any form of the plain command.

**Why:** a summarized stream reads exactly like "that line is not in the log", which inverts a
diagnosis (a working GPU looked like no GPU discovery).

**`grep` does it too — MEASURED 2026-09-18, and it cost a wrong read of a file I was editing.**
`grep -n '^| \`' docs/plans/README.md`, extracting the archive table's slugs, answered
`110 matches in 1 files`followed by unrelated leading lines of the file rather than the matching
rows — so the extraction came back empty while`grep -c`on the SAME pattern answered`30`correctly. The count form survived, the listing form did not.`/usr/bin/grep`returned the real
matches. A`<n> matches in <n> files`header is the tell, exactly as`[docker] Logs for <name>:` is.

**A TOOL RUNNER does it too, and there the summary is a VERDICT — MEASURED 2026-09-22.**
`npx tsc -p tsconfig.typecheck.json --listFiles` answered the single line
`TypeScript: No errors found` and listed no files, so a `grep` over it counted 0 and read as "the
typecheck program does not include this file". `npx tsc --version` answered the SAME sentence, which
is the proof it was never tsc. `node ./node_modules/typescript/bin/tsc -p … --listFiles` listed the
files and the greps hit. `npx prettier --check <file>` likewise answers
`Prettier: All files formatted correctly` where the real binary prints `Checking formatting...` plus
its own verdict.

**Why this instance is worse than the log one:** a summarized log looks like a missing line, which is
at least suspicious. A summarized checker prints a PASS, so a run that never happened is
indistinguishable from a clean one — and it is affirmative evidence in a commit message.

**How to apply:** whenever the presence, absence or exact text of a match is evidence, call the
`/usr/bin/` form — `/usr/bin/docker logs …`, `/usr/bin/grep …` — and for a node tool run the binary
under `node_modules` directly rather than through `npx`. Assume any plain wrapped command can
answer with a summary, and treat "found nothing" from one as unproven rather than as a result.
Same absolute-path escape as [[worktree-guard-rtk-git]]. Used by [[haive-gpu-stack-restart]].

`ls` is wrapped too: on 2026-09-25 a plain `ls -la .claude/worktrees/` listed two of three worktree
dirs, which read as a missing worktree while `/usr/bin/ls -la` showed all three. Before a cleanup
decides what exists, list with `/usr/bin/ls`.
