---
name: ci-uid-differs-from-dev-host
description: "CI's runner uid is neither 0 nor 1000, so uid-dependent permission code takes a different branch than on this host"
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-17T06:55:48.089Z
---

This dev host runs as uid 1000, which IS `SANDBOX_UID`. GitHub's runner is non-root and
not 1000. So any code branching on `process.getuid()` against `SANDBOX_UID` takes a
DIFFERENT path in the two places — `sandboxWritableTreeRepair` picks `chmod-owner` here
and `chmod-other` there — and a green local run says nothing about the other branch.
Compounding it: the `rootIt` helper in `worktree-permissions.test.ts` is `getuid() === 0`,
so those cases run on NEITHER this host nor CI.

**Why:** a permission repair passed locally and went red on CI (PR #129, `eced30b9`)
because `o+rwX` grants the `other` class while the kernel matches the OWNER class for the
process that owns the tree — reachable only on the non-1000 branch. Cost a CI round trip
and, more importantly, the same hole had existed unnoticed in the `chmod -R` shell-out it
replaced.

**How to apply — three concrete checks, not a reminder to think.** This bit three times
(PR #129; PR #131 with `EPERM chown '/proc/self/fd/N'` from `walkDir`; PR #132, where a 0700
stage owned by root stopped the uid-65534 extraction tool TRAVERSING into the directory it
had been told to write into), so:

1. **Grep the diff for `chown`, `owner:` and `uid`.** For each hit ask: does this run
   unguarded? If the code it replaces had `.catch(() => {})`, ownership was BEST-EFFORT and
   must stay so — moving it into a helper that throws converts a degraded path into a
   failed one. In `@haive/shared/fs-safe` the `owner` option is strict everywhere
   (`walkDir`'s create path, `createExclusive`), so a best-effort caller passes NO owner and
   calls `chownNoFollow(...).catch(() => {})` itself.
2. **Say in the PR which branch is covered where.** A local pass on this host proves only
   the uid-1000 branch.
3. **A mode is only half of it — ask who has to TRAVERSE the path.** Ownership is not the only
   uid-dependent axis. A directory the worker owns at 0700 is correct until something runs
   underneath it as a different uid, and then every ancestor needs `x`. Wherever the code drops
   privileges, walk the whole chain and MEASURE the real one in the container
   (`stat -c '%a %U %n'`): every production anchor level here is 0755 — `/var/lib/haive`, the
   repos and bundles roots, each `<userId>` and `<repoId>`, `.haive`, the uploads dir — while
   `mkdtemp` is ALWAYS 0700, so a fixture built on it fails as root where production would not,
   and the fixture is then what to fix.

Two CI jobs in this repo run at DIFFERENT uids, which is what makes a root-only branch testable
at all: the host `Unit tests` job is non-root and never 0, and the in-image `compose-boot`
extraction step is root. A branch gated on `getuid() === 0` runs in the second only.

Spoofing `getuid` with `vi.spyOn` does NOT reach the other branch — the repair also
requires `root.uid === workerUid`, so a spoofed uid on a tree this user owns resolves to
`unavailable`. Prefer an assertion that holds on BOTH branches (the verdict, or "the
owner can write afterwards") over one keyed to a literal mode.
Related: [[haive_dev_host_masks_installer_tests]], [[haive_pr_workflow]].
