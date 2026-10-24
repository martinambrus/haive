---
name: inode-reuse-breaks-replaced-dir-tests
description: "A directory removed and immediately recreated can come back with the SAME inode (measured on ext2/ext3), so rm+mkdir does not produce a 'this was replaced' fixture — and inode identity cannot be the load-bearing test for a replaced path in production either"
metadata:
  node_type: memory
  type: reference
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-21T19:47:21.576Z
---

MEASURED 2026-09-21 on this host's `/tmp` (`stat -f -c %T` reports **ext2/ext3**): `mkdir x`,
`stat -c %i` → **1003682**, `rmdir x`, `mkdir x`, `stat -c %i` → **1003682** again. The freed inode
is the first candidate for the next allocation in the same parent, so an immediate recreate reuses it.

**What it cost.** A test for `removeAgentMaskStubs` (worker agent-definition mask) produced its
"the directory was replaced between the scan and container create" fixture by `rm`-ing the directory
and `mkdir`-ing it again, then asserted the stub was cleaned. The code compares the recorded inode
with the one on disk; the reused number made them equal, the comparison took its "unchanged" branch,
and the test failed against CORRECT code. Rewritten to set an inode that differs by construction
(`records[0].inode + 1`), which is deterministic and exercises the same branch.

**The bigger half:** this also bounds what such a comparison can do in PRODUCTION. If Docker
recreates a mount target after the original directory was removed, the filesystem may hand it the
same inode number, and an inode check will read the stub as the repository's own directory. So inode
identity is a cheap early exit, never the load-bearing discriminator.

**And bare ownership is not the discriminator either** — that was my next answer and it was also
wrong, caught by a reviewer before it shipped. "Inode differs, owned by the uid the container ran as,
and empty" is satisfied by a LEGITIMATE host-side recreate: a root-owned local-path repository whose
directory is removed and recreated mid-run matches all three, and deleting it is real data loss.
Provenance has to be AFFIRMATIVE: the container's uid must DIFFER from the owner of the repository
tree, so Docker's root-owned mountpoint inside a uid-1000 repo is removable while a root-owned repo's
own root-owned directory is not. When the two match, provenance is unknown and the directory is KEPT
— an empty stub is clutter, and clutter is the direction to fail in.

**How to apply.** To fixture "this path was replaced", construct the differing identity rather than
performing a real delete-and-recreate. And before keying production logic on inode equality, ask what
happens when the number is reused — if the answer is "we treat a foreign path as ours", find a second
signal. Related: [[fixed-tmp-path-in-test-masks-failure]] for the neighbouring class of fixture that
passes for the wrong reason, and [[agent-isolation-open-items]] for the change this came out of.
