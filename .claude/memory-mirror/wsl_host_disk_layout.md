---
name: wsl-host-disk-layout
description: "Both WSL disk images live on host C:, ~40 GB free on 2026-09-25 and 15 GB on 2026-10-02 (vhdx sizes unchanged); df inside WSL is not the host's free space, and the vhdx files never shrink on their own"
metadata:
  node_type: memory
  type: reference
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-09-25T08:13:59.004Z
---

MEASURED 2026-09-25 (read-only, via `powershell.exe` interop):

- Host C: 39.6 GB free / 425 GB used. The user said it was ~200 GB free a week earlier.
- `C:\Users\Activit\AppData\Local\Docker\wsl\disk\docker_data.vhdx` = 167 GB. `docker system df`:
  images 84.3 GB (60.7 reclaimable), build cache 41.8 GB (20.5 reclaimable), volumes 32.8 GB,
  containers 0.5 GB.
- `...\Packages\CanonicalGroupLimited.Ubuntu24.04LTS_79rhkp1fndgsc\LocalState\ext4.vhdx` = 154.6 GB,
  while `df /` inside WSL showed only 83 GB used (and 874 GB "free", the vhdx's logical size).
- `.claude/worktrees/` held 2.3 GB of real data (13 worktrees, pnpm hardlinks), so worktrees are
  not the main consumer.
- WSL 2.3.26.0, no `%USERPROFILE%\.wslconfig`.

MEASURED 2026-10-02 (`Get-PSDrive C`): 15.1 GB free, yet both vhdx files were EXACTLY the 09-25
sizes (167 / 154.6 GB) after a week of worktrees, installs and smokes, so WSL reuses its internal
slack and the ~24 GB lost came from the Windows side. Worktrees are still not the consumer.

**Why it matters:** `df` inside WSL says nothing about the host. Deleting inside WSL or Docker frees
blocks inside the vhdx but does not shrink the file; returning space to C: needs a compaction with
everything stopped (`wsl --shutdown`, then Optimize-VHD or diskpart, which need admin), or the
distro's sparse mode. Neither has been tested on this machine.

**How to apply:** before creating big artifacts (images, worktrees, scratch DBs), read host free
space with `powershell.exe -NoProfile -Command "Get-PSDrive C"`. Never prune Docker or shut WSL
down without asking: the daemon is shared with Windows projects and other sessions, and project
volumes must never be pruned. Related: [[haive-pr-workflow]] (the worktree rule),
[[windows-and-wsl-share-one-docker-daemon]].
