---
name: windows-wsl-share-one-docker-daemon
description: On this machine PowerShell and WSL drive the SAME Docker daemon, so a "Windows install" and a "WSL install" collide unless namespaced
metadata:
  type: reference
---

Docker Desktop's WSL2 integration means `powershell.exe docker` and WSL's `docker` are ONE
daemon, not two. VERIFIED 2026-09-08: `docker info --format '{{.ID}}'` returns the identical
id from both (`ace03edf-…`), and containers/volumes created from either shell are visible
from the other. WSL's context is `default` (unix socket); Windows' is `desktop-linux` (npipe);
both reach the same engine.

**How to apply:** when testing a "Windows install" of Haive beside a WSL one, they are two
installs on one daemon — give each its own `HAIVE_INSTALL_ID` or they share containers,
volumes and networks. Published ports are forwarded to Windows localhost too, so a port
taken by a WSL stack is genuinely taken on the Windows side.

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\path\script.ps1'` runs a
Windows-side script from WSL; copy it via `/mnt/c/Users/<user>/`. Parse-check without
executing:
`[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)`.

See [[haive-pr-workflow]] for the ship cycle these tests feed.
