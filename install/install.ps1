<#
.SYNOPSIS
  Haive one-line installer for Windows (RUN-IT).

.DESCRIPTION
  Installs a PUBLISHED release: fetches a versioned compose bundle, generates this install's own
  secrets, pulls images and boots the stack. Builds nothing and clones nothing.

  Windows needs Docker Desktop and NOTHING ELSE. Docker Desktop uses WSL2 as its engine, but that
  is its plumbing, not a requirement on your shell: `docker` and `docker compose` answer natively
  from PowerShell and no WSL distro is involved. (Building Haive FROM SOURCE is a different job
  and does require WSL2 — see AGENTS.md. This script never builds.)

.EXAMPLE
  irm https://raw.githubusercontent.com/martinambrus/haive/main/install/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Version 0.1.4 -Dir C:\haive
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Dir,
  [string]$InstallId,
  [string]$Channel = 'public',
  [switch]$Check,
  [switch]$Force,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

# Piped through `iex` there are no parameters, so the same options are readable from the
# environment. `$env:HAIVE_INSTALL_VERSION='0.1.4'; irm ... | iex` works exactly like -Version.
if (-not $Version -and $env:HAIVE_INSTALL_VERSION) { $Version = $env:HAIVE_INSTALL_VERSION }
if (-not $Dir     -and $env:HAIVE_INSTALL_DIR)     { $Dir     = $env:HAIVE_INSTALL_DIR }
if (-not $Check   -and $env:HAIVE_INSTALL_CHECK)   { $Check   = $true }
if (-not $InstallId -and $env:HAIVE_INSTALL_ID)    { $InstallId = $env:HAIVE_INSTALL_ID }

$Repo             = if ($env:HAIVE_REPO) { $env:HAIVE_REPO } else { 'martinambrus/haive' }
$RegistryDefault  = 'ghcr.io/martinambrus'
$Raw              = "https://raw.githubusercontent.com/$Repo"
$Releases         = "https://github.com/$Repo/releases/download"
$ApiBase          = "https://api.github.com/repos/$Repo"

function Write-Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Note($m) { Write-Host "  $m" }
function Write-Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# ── Preflight ────────────────────────────────────────────────────────────────
# Prerequisites are CHECKED, never installed. Docker Desktop is a GUI application with a licence
# agreement that is commercial above a company-size threshold; nobody can accept that on the
# user's behalf, and a script that tried would be doing something worse than failing.

function Test-Preflight {
  Write-Step "Checking prerequisites"
  $ok = $true

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Missing: docker"
    Write-Host "  Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
    $ok = $false
  } else {
    Write-Note "docker            found"
    # `docker info` is the only check that proves the ENGINE is up. Docker Desktop installs the
    # CLI whether or not the VM is running, so presence of the binary proves nothing.
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Missing: a reachable Docker daemon"
      Write-Host "  Docker Desktop is installed but not running. Start it from the Start menu and"
      Write-Host "  wait for the whale icon to stop animating, then re-run this."
      $ok = $false
    } else {
      Write-Note "docker daemon     reachable"
    }
  }

  if ($ok) {
    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Missing: Docker Compose v2"
      Write-Host "  'docker compose' (with a space) is required. Update Docker Desktop."
      $ok = $false
    } else {
      Write-Note "docker compose    $(docker compose version --short 2>$null)"
    }
  }

  # Linux containers, not Windows containers: every image in the stack is a Linux image, and in
  # Windows-container mode the pull fails with a manifest error that names no cause.
  if ($ok) {
    $os = (docker version --format '{{.Server.Os}}' 2>$null)
    if ($os -and $os -ne 'linux') {
      Write-Host "Docker Desktop is in $os-container mode."
      Write-Host "  Haive's images are Linux images. Right-click the Docker tray icon and choose"
      Write-Host "  'Switch to Linux containers', then re-run this."
      $ok = $false
    } elseif ($os) {
      Write-Note "container mode    $os"
    }
  }

  $mem = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  if ($mem -gt 0) {
    if ($mem -lt 8) {
      Write-Warn "this machine has $mem GB RAM. Haive budgets agents and runtimes against roughly 70% of it, so expect one agent at a time. 16 GB or more is comfortable."
    } else {
      Write-Note "memory            $mem GB"
    }
  }

  if (-not $ok) { Die "prerequisites are missing (see above). Nothing was changed." }
  Write-Host ""
  Write-Host "Ready to install."
}

# ── Version resolution ───────────────────────────────────────────────────────
# An alias is resolved to a concrete version BEFORE anything is written, so an install cannot
# drift onto a moving tag and silently upgrade itself on the next `docker compose up`.

function Resolve-HaiveVersion([string]$want) {
  if (-not $want -or $want -eq 'latest') {
    try { return (Invoke-RestMethod "$ApiBase/releases/latest").tag_name }
    catch { Die "could not resolve the latest release from GitHub. Check your network, or pass -Version <v>." }
  }
  if ($want -eq 'next') {
    try { return (Invoke-RestMethod "$ApiBase/releases?per_page=1")[0].tag_name }
    catch { Die "could not resolve a prerelease from GitHub. Check your network, or pass -Version <v>." }
  }
  if ($want.StartsWith('v')) { return $want }
  return "v$want"
}

function New-HexSecret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-Bundle([string]$url, [string]$dest) {
  try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
  catch { Die "could not download $url" }
}

# Validated here rather than at first use: it names Docker volumes and Postgres databases, and
# compose builds both `<id>-api` and `<id>_repos` from it without being able to convert between
# the conventions - so a `-` inside it would leave the two halves of one install disagreeing.
if (-not $InstallId) { $InstallId = 'haive' }
if ($InstallId -notmatch '^[a-z0-9][a-z0-9_]*$') {
  Die "-InstallId must be [a-z0-9_] starting with a letter or digit, and was '$InstallId'."
}

Test-Preflight
if ($Check) { Write-Host ""; Write-Host "-Check: nothing was installed."; exit 0 }

if ($Channel -ne 'public') { Die "channel '$Channel' is not available yet. Only the public channel is published today." }

Write-Step "Resolving the release"
$tag    = Resolve-HaiveVersion $Version
$pinned = $tag -replace '^v', ''
Write-Note "requested         $(if ($Version) { $Version } else { 'latest' })"
Write-Note "resolved          $pinned  (tag $tag)"

# Verify the release EXISTS before generating a secret or pulling an image, so a typo costs
# nothing. Its manifest is the artefact an upgrade reads too.
try { Invoke-WebRequest -Uri "$Releases/$tag/release.json" -UseBasicParsing -Method Head | Out-Null }
catch { Die "release $tag has no published manifest.`n       Check the version, or list what exists: https://github.com/$Repo/releases" }
Write-Note "manifest          found"

if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE $InstallId }
$Dir = [System.IO.Path]::GetFullPath($Dir)

if ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir | Measure-Object).Count -gt 0) {
  if (Test-Path (Join-Path $Dir '.env')) {
    Die @"
$Dir already holds a Haive install.
       The installer never upgrades: running an install command is not consent to migrate a live
       database, and none of the drain, snapshot or health-gate steps that make an upgrade safe
       happen here. Upgrade from the admin console's Maintenance page, or:
         cd $Dir; .\haive.ps1 upgrade -Version <v>
"@
  }
  if (-not $Force) { Die "$Dir is not empty. Pass -Force to install into it anyway." }
}

Write-Step "Writing the install to $Dir"
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'snapshots') | Out-Null
Push-Location $Dir

Get-Bundle "$Raw/$tag/docker-compose.yml"     (Join-Path $Dir 'docker-compose.yml')
Get-Bundle "$Raw/$tag/docker-compose.run.yml" (Join-Path $Dir 'docker-compose.run.yml')
Write-Note "compose bundle    docker-compose.yml + docker-compose.run.yml"

# No GPU overlay on Windows. Docker Desktop can pass an NVIDIA GPU through on some setups, but the
# stack boots correctly on CPU either way and probing it here would be a claim this script has not
# measured. Ollama runs on CPU; that is a supported configuration, not a degraded one.
Write-Note "ollama            CPU"

$envPath = Join-Path $Dir '.env'
if (-not (Test-Path $envPath)) {
  $key  = New-HexSecret 32
  $jwt  = New-HexSecret 32
  $pgpw = New-HexSecret 16
  if (-not $key -or -not $jwt -or -not $pgpw) { Die "could not generate secrets. Nothing was installed." }

  # HOST_REPO_ROOT is written EXPLICITLY and this is the one Windows-specific hard requirement.
  # docker-compose.yml defaults that mount to ${HOME}, and PowerShell does not set HOME as an
  # ENVIRONMENT variable ($HOME is a shell variable, which Compose cannot see). MEASURED: the
  # default then fails the stack outright with
  #   The "HOME" variable is not set. Defaulting to a blank string.
  #   invalid spec: :/host-fs:ro: empty section between colons
  # Both `C:\Users\x` and `/c/Users/x` are accepted by Docker Desktop; the native form is written
  # because that is what was verified to list the directory's real contents from a container.
  $lines = @(
    "# Haive install - generated $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
    "# Keep this file. CONFIG_ENCRYPTION_KEY is the master key for every secret this install"
    "# stores; lose it and stored credentials cannot be decrypted."
    ""
    "HAIVE_VERSION=$pinned"
    "HAIVE_REGISTRY=$RegistryDefault"
    ""
    "# Names every container, volume, network and database this install owns. Two installs on one"
    "# machine need two ids, or the second silently mounts the first one's cloned repositories."
    "HAIVE_INSTALL_ID=$InstallId"
    "COMPOSE_PROJECT_NAME=$InstallId"
    ""
    "CONFIG_ENCRYPTION_KEY=$key"
    "JWT_SECRET=$jwt"
    "POSTGRES_PASSWORD=$pgpw"
    ""
    "HAIVE_WEB_PORT=3000"
    "HAIVE_API_PORT=3001"
    "HAIVE_MAILPIT_PORT=8025"
    ""
    "HOST_REPO_ROOT=$env:USERPROFILE"
    "HAIVE_INSTALL_DIR_HOST=$Dir"
  )
  # LF, not CRLF, and written without a BOM: compose reads this file itself and a stray carriage
  # return lands inside the VALUE of the last variable on every line.
  [System.IO.File]::WriteAllText($envPath, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "secrets           generated (.env)"
}

# ── Helper scripts ───────────────────────────────────────────────────────────

$haivePs1 = @'
# Haive control script for this install. Generated by the installer.
param([Parameter(Position=0)][string]$Command = 'help', [string]$Version, [switch]$ForceDrain)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$files = @('-f','docker-compose.yml','-f','docker-compose.run.yml')

function Get-DotEnv {
  $h = @{}
  Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k,$v = $_ -split '=', 2; $h[$k.Trim()] = $v.Trim()
  }
  $h
}

switch ($Command) {
  'up'      { docker compose @files up -d }
  'down'    { docker compose @files down }
  'logs'    { docker compose @files logs -f }
  'ps'      { docker compose @files ps }
  'version' { $e = Get-DotEnv; Invoke-RestMethod "http://localhost:$($e['HAIVE_API_PORT'])/version" | ConvertTo-Json }
  'upgrade' {
    if (-not $Version) { Write-Host "usage: .\haive.ps1 upgrade -Version <v>"; exit 2 }
    $e = Get-DotEnv
    $v = $Version -replace '^v',''
    # The updater runs OUTSIDE this compose project: a process cannot bring itself down and
    # survive to verify the result or roll it back.
    $dargs = @(
      'run','--rm','-it',
      '--network', "$($e['HAIVE_INSTALL_ID'])-network",
      '-v','/var/run/docker.sock:/var/run/docker.sock',
      '-v', "$($e['HAIVE_INSTALL_DIR_HOST']):/install",
      '-e', "COMPOSE_PROJECT_NAME=$($e['COMPOSE_PROJECT_NAME'])",
      '-e', "DATABASE_URL=postgres://haive:$($e['POSTGRES_PASSWORD'])@postgres:5432/haive",
      '-e', 'REDIS_URL=redis://redis:6379',
      '-e', "CONFIG_ENCRYPTION_KEY=$($e['CONFIG_ENCRYPTION_KEY'])",
      "$($e['HAIVE_REGISTRY'])/haive-updater:$v",
      '--manifest', "https://github.com/martinambrus/haive/releases/download/v$v/release.json",
      '--install-dir','/install',
      '--registry', $e['HAIVE_REGISTRY'],
      '--postgres-volume', "$($e['COMPOSE_PROJECT_NAME'])_postgres_data",
      '--snapshot-host-dir', "$($e['HAIVE_INSTALL_DIR_HOST'])/snapshots",
      '-e', "HAIVE_INSTALL_ID=$($e['HAIVE_INSTALL_ID'])"
    )
    if ($ForceDrain) { $dargs += '--force' }
    & docker @dargs
  }
  default { Write-Host "usage: .\haive.ps1 up|down|logs|ps|version|upgrade -Version <v>" }
}
'@
[System.IO.File]::WriteAllText((Join-Path $Dir 'haive.ps1'), $haivePs1, (New-Object System.Text.UTF8Encoding($false)))

# Uninstall deliberately does NOT use `down -v`. Five volumes in docker-compose.yml carry an
# explicit global name, so they are shared with any other Haive on this machine and `-v` would
# take another install's cloned repositories with it.
$uninstall = @'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$project = (Get-Content .env | Where-Object { $_ -match '^COMPOSE_PROJECT_NAME=' }) -replace '^COMPOSE_PROJECT_NAME=',''
if (-not $project) { $project = 'haive' }
Write-Host "Removing the Haive stack and THIS install's data volumes."
Write-Host "Project: $project"
$reply = Read-Host "Type the project name to confirm"
if ($reply -ne $project) { Write-Host "aborted."; exit 1 }
docker compose -f docker-compose.yml -f docker-compose.run.yml down
foreach ($v in @('postgres_data','redis_data','mailpit_data','ollama_data')) {
  docker volume rm "${project}_$v" 2>$null | Out-Null
}
Write-Host ""
Write-Host "These volumes are NOT removed, because they are named globally and shared with any"
Write-Host "other Haive install on this machine:"
Write-Host "  haive_repos  haive_bundles  haive_wrappers  haive_squid_configs  haive_ddev_ca"
Write-Host "  haive_npm_cache  haive_ddev_registry_cache"
Write-Host ""
Write-Host "haive_repos holds your cloned repositories. If this was the only install, remove them:"
Write-Host "  docker volume rm haive_repos haive_bundles haive_wrappers haive_squid_configs haive_ddev_ca"
'@
[System.IO.File]::WriteAllText((Join-Path $Dir 'uninstall.ps1'), $uninstall, (New-Object System.Text.UTF8Encoding($false)))
Write-Note "helpers           .\haive.ps1, .\uninstall.ps1"

if ($NoStart) {
  Write-Host ""
  Write-Host "-NoStart: written but not booted. Start it with:  cd $Dir; .\haive.ps1 up"
  Pop-Location
  exit 0
}

Write-Step "Pulling images (this is the slow part)"
docker compose -f docker-compose.yml -f docker-compose.run.yml pull --quiet
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "could not pull the images. Check your network and that the release exists." }

Write-Step "Starting Haive"
docker compose -f docker-compose.yml -f docker-compose.run.yml up -d
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "the stack did not start. Look at the logs:  cd $Dir; .\haive.ps1 logs" }

Write-Step "Waiting for the API"
$port = 3001
$healthy = $false
for ($i = 0; $i -lt 120; $i++) {
  try {
    Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
    $healthy = $true; break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Pop-Location; Die "the API never became healthy. Look at the logs:  cd $Dir; .\haive.ps1 logs api" }
Write-Note "api               healthy"

Pop-Location
Write-Host ""
Write-Host "  Haive $pinned is running." -ForegroundColor Green
Write-Host ""
Write-Host "    Web       http://localhost:3000"
Write-Host "    API       http://localhost:3001"
Write-Host "    Mail      http://localhost:8025"
Write-Host "    Directory $Dir"
Write-Host "    Install   $InstallId"
Write-Host ""
Write-Host "  Manage it with .\haive.ps1 up|down|logs|ps|version|upgrade, remove it with .\uninstall.ps1."
Write-Host ""
Write-Host "  One thing you should know before you use it:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    The Haive worker mounts the Docker socket, so it can create and destroy containers"
Write-Host "    on this machine. That is how it runs AI CLIs in sandboxes - and it is equivalent to"
Write-Host "    root on the host. Run Haive on a machine where that is acceptable."
Write-Host ""
