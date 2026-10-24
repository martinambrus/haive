---
name: proc-self-fd-is-per-child
description: "unzip and pdftotext DO accept /proc/self/fd/N, but that path resolves in the CHILD's fd table — execFile passes no extra descriptors, so containing a subprocess path needs spawn + stdio"
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-18T10:01:06.323Z
---

The fs-safe containment series closed every host-side read, write, move and delete, but left one
class open: subprocesses resolve a path of their own BY NAME. `00-plan-inputs.ts:337` says so in a
comment, and `extractPlanInput` still takes an absolute path for `unzip`/`pdftotext`.

**MEASURED 2026-09-18 inside `haive-worker`, all three shapes the extractors use:** `unzip -p
/proc/self/fd/3 <member>`, `unzip -Z1 /proc/self/fd/3` and `pdftotext /proc/self/fd/3 -` ALL work,
byte-identical to the same call on a normal path. pdftotext's failure modes distinguish cleanly: a
descriptor it can open but not parse gives `Syntax Warning: May not be a PDF file (continuing
anyway)`, while a path that does not exist gives `I/O Error: Couldn't open file … No such file or
directory`. So the tools are not the obstacle.

**Why:** `/proc/self/fd/N` resolves against the **child's** own fd table, not the parent's. The
probes above only passed because the shell's `3< file` handed fd 3 TO THE CHILD. A child with no
such descriptor answers `unzip: cannot find or open /proc/self/fd/3, /proc/self/fd/3.zip or
/proc/self/fd/3.ZIP.` — measured as the control. So interpolating the worker's own `fh.fd` into argv
points at nothing, because `execFile` (and `promisify(execFile)`, which `_plan-inputs.ts` uses) passes
no extra descriptors to the child.

**How to apply:** open with `openFileNoFollow(anchor, rel, 'read')` — it returns a real
`FileHandle | null`, so `.fd` is available — then `spawn` with `stdio: ['pipe','pipe','pipe', fh.fd]`
and put `/proc/self/fd/3` in the argv, using the CHILD's number rather than the parent's `fh.fd`
value. Close the handle in a `finally` (see [[node26-filehandle-gc-is-fatal]]). Always run a
no-descriptor control: it fails loudly, which is what proves the plumbing rather than the tool. Note
that this makes the change a `spawn` migration of three call sites with stdout capture rewritten, not
a string substitution — and `unzipMemberOrNull` swallows failures as "no such part", so a plumbing
mistake there would be silent. One descriptor should serve a whole document, since an xlsx makes
several `unzipMember` calls.
