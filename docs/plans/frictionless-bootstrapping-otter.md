# One-line install for Haive

> **The installer SHIPPED 2026-09-08** as `install/install.sh` and `install/install.ps1`, and was
> exercised on both platforms against published images — see "As built" below. Still absent from
> it: first-admin bootstrap (owned by `anointing-gatekeeping-ibex`) and non-public channels.
>
> Status: PROPOSED, 2026-08-25. Prompted by the DeepSeek `dsh` harness (harness.pdf), whose entire
> install is `npx @deepseek-ai/dsh web` — a browser tab opens, asks for an API key, and a full
> harness is running locally with no account and no cloud session. This plan asks what the
> equivalent is for Haive, and is honest that Haive is a heavier thing than a single Node process.
>
> Extended 2026-09-07 with three sections the original did not have, each folded in place rather
> than appended: the install-time CHANNEL (a module customer does not run the public images), macOS
> as a first-class RUN-IT target with its arch and GPU limits, and the no-terminal path — a Docker
> Desktop Extension, with a downloadable double-click installer rejected on evidence. The shape of
> the command and the security rules are unchanged.
>
> Extended again 2026-09-08: `--version` (install ANY published release, alias resolved then PINNED
> so an install cannot drift onto a moving tag), and the prerequisites policy — checked and
> instructed, never installed. Also records why two installs cannot yet share a machine. Images are
> now real: `ghcr.io/<owner>/haive-{api,worker,web}`, public and multi-arch, first published as
> v0.1.0 on 2026-09-08.
>
> **Corrected 2026-09-08:** this plan claimed WSL2 was required on Windows and put Windows-native
> out of scope. Wrong for RUN-IT — WSL2 is Docker Desktop's ENGINE, not a requirement on the user's
> shell, and nothing in a published-image install needs a WSL distro. That claim was inherited from
> AGENTS.md's DEVELOPER-environment constraint, where it is true and stays. See Platforms, where the
> Windows mechanics are now MEASURED against Docker Desktop 29.7.2 — including the `$env:HOME`
> failure, which is a hard stop rather than a degradation.

## The gap

Installing Haive today is a developer checkout: clone the repo, hand-write `.env` from
`.env.example` (which requires a manually supplied 32-byte-hex `CONFIG_ENCRYPTION_KEY` and DB
credentials), and run `pnpm docker:dev` (`scripts/dev.sh`), which builds every image from source,
GPU-aware. That is correct for a contributor and wrong for a first-time user who just wants to try
Haive. The good companies ship a single line; Haive should too.

## The honest asymmetry with dsh

dsh is one Node process, so `npx` genuinely IS the whole install. Haive is a Docker Compose stack —
postgres, redis, mailpit, api, worker, web, and a GPU-aware Ollama — and the worker mounts the
Docker socket (effectively root on the host). A one-line install for Haive is achievable, but it
bootstraps containers, not a script, and it must say so rather than pretend to be weightless. The
target is "one command, then a browser tab," not "one dependency."

## Two install modes, named so they are not conflated

1. RUN-IT (this plan): a non-developer runs Haive locally from PUBLISHED images. One command fetches
   a versioned compose bundle, generates secrets, pulls images, and opens the app. No source, no
   build. This is the dsh-equivalent and what "one-line install" means.
2. DEV-IT (exists, unchanged): a contributor clones the repo and runs `pnpm docker:dev`, building
   from source. The installer does not touch this path.

The split matters because RUN-IT has a hard prerequisite DEV-IT does not: **published, versioned
images in a public registry**. That is the real cost of this feature, and most of the work.

**RUN-IT's "no build" collided with the module system; DECIDED 2026-09-07 in favour of per-customer
images.** A module is rebuild-on-install by `serialized-chasing-thacker`'s locked decision — the
customer adds a dependency and rebuilds api+worker — which a RUN-IT host, having no source and no
toolchain, cannot do. The resolution keeps RUN-IT's promise exactly as written: the VENDOR builds
api+worker with that customer's entitled modules and publishes a private per-customer tag, so the
install still performs no build and holds no registry token. See "DECIDED — a published-image
install gets PER-CUSTOMER images built by the vendor" in that plan, which owns the reasoning and the
rejected alternatives.

Two consequences land on this plan, and neither costs the default install anything. A module
customer's compose bundle pins their per-customer api+worker tags (web stays the stock public image,
since nav and pages are runtime-fetched), so the installer fetches the manifest for the customer's
channel rather than the public one. And a user installing their OWN module — from a git URL or by
folder-drop — pulls a `haive-builder` image the stack runs as a one-shot to build api+worker
locally; they never clone Haive and never install a toolchain, so no RUN-IT user is pushed into
DEV-IT to extend their own install. The delivery matrix for all four combinations is in that plan.

A module-free RUN-IT install is unaffected in every respect and remains the default this plan
describes. Worth knowing for the installer's copy: authoring a TASK TYPE needs none of this —
`rippling-wibbling-puffin` makes task types data, and states at its Phase 3.1 that prompt-template
steps "need no rebuild". Only a module contributing steps, routes or jobs does.

## Shape of the command

`curl -fsSL https://get.haive.dev | sh` (and a `powershell -c "irm get.haive.dev/install.ps1 | iex"`
sibling), or `npx create-haive`. All three do the same bootstrap:

1. Preflight: Docker Engine + Compose v2 present and the daemon reachable (on Windows that means
   Docker Desktop — see Platforms); enough free RAM and disk for the stack's reserve budget; and the
   REQUESTED VERSION actually exists. Fail with a specific fix per missing prerequisite, never a stack trace — and fail here,
   before any secret is generated or any image pulled, so a typo costs nothing.
2. Pick an install dir (default `~/haive`), refuse to clobber a non-empty one without `--force`.
3. Fetch the versioned compose bundle for the pinned release **on this install's CHANNEL**:
   `docker-compose.yml` plus a `docker-compose.run.yml` overlay that references `image:` tags
   instead of `build:` contexts. NOT the source tree.
4. Generate secrets into `.env`: `CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)`, a random DB
   password, SMTP left at Mailpit. This is the security-critical step — see below. Write
   `HAIVE_INSTALL_DIR_HOST=<the absolute install dir>` in the same file: the api hands that path to
   `docker run -v` when it launches the updater, and the daemon resolves it on the HOST, so nothing
   inside a container can work it out. Omitting it is not fatal — the in-app Upgrade button is
   simply not offered and the admin page says which line is missing — but it is the difference
   between an owner who can upgrade from the UI and one who needs a shell.
5. GPU detection: probe for an NVIDIA runtime and select the GPU overlay; otherwise default to
   CPU, and default Ollama to a small local model or to cloud Ollama, so a laptop without a GPU
   still boots. (Mirror the GPU layering `scripts/dev.sh` already does.)
6. `docker compose ... up -d`, pulling published images. Run the DB-migrate one-shot (the dev
   override already has this shape) before api/worker accept traffic.
7. Wait for `/health`, then hand off to first-run setup (below) and open `http://localhost:3000`.

### `--version` — any published release, resolved then PINNED

`--version <v>` installs a specific release; without it the installer takes the newest stable one.
It accepts an exact version (`0.1.0`) or an alias (`latest`, `next` for prereleases), and **an alias
is resolved to a concrete version before anything is written**. What lands in `.env` is always
`HAIVE_VERSION=0.1.0`, never `HAIVE_VERSION=latest`.

That resolve-then-pin step is the whole point, not a detail. An install left pointing at a moving
tag changes underneath its owner on the next `docker compose up` — a silent, unrequested upgrade
with no migration gate, no snapshot and no health check, which is precisely what
`steadfast-committing-gray` exists to prevent. It is also why `docker-compose.run.yml` gives
`HAIVE_VERSION` no default and fails the command outright when it is unset.

Installing an OLDER version is allowed and useful — reproducing a bug, or standing up a known-good
baseline to upgrade FROM. `minFrom` governs upgrades between versions; it has nothing to say about
which version a FRESH install starts at.

**The installer never upgrades.** Re-running it against an existing install is refused (the
non-empty-directory guard above) with a pointer to `haive upgrade`, whatever `--version` says.
Running an install command is not consent to migrate a live database, and the installer performs
none of the drain, snapshot or health-gate steps that make an upgrade safe. Which version an
existing install may move to, whether a jump needs intermediate stops, and why a downgrade is
refused are all `steadfast-committing-gray`'s to answer — see "Choosing what to upgrade TO".

The requested version is verified to exist during preflight by fetching its release manifest. A
version that does not resolve fails before secrets are generated or images pulled, rather than
after — and the manifest is needed anyway, since it carries the image digests.

### Prerequisites are CHECKED, never installed

The installer does not install Docker, and that is a decision rather than an omission:

- It is privileged and OS-specific — adding a package repository, `sudo`, and group membership that
  needs a re-login before it takes effect.
- On macOS and Windows it is Docker **Desktop**: a GUI application with a licence agreement that is
  commercial above a company-size threshold. Nobody can accept that on the user's behalf, and a
  script that tried would be doing something worse than failing.
- A `curl | sh` that also installs a root-equivalent daemon is a far larger trust ask than one that
  boots containers, and this plan already owes the user an honest disclosure about the Docker
  socket. Silently installing the socket's daemon too is the wrong direction.
- Docker publishes its own installer. Pointing at `https://get.docker.com` (or Docker Desktop for
  macOS/Windows) hands the user the vendor's supported path instead of our approximation of it.

So preflight detects and instructs: name the missing piece, the exact command or download for THIS
platform, and stop. `--check` runs preflight alone and changes nothing, which is also what a support
conversation should start with.

**What is actually required is short, and worth stating positively:** Docker Engine and Compose v2,
plus WSL2 on Windows. That is the entire list. No Node, no pnpm, no Postgres, no Redis — a RUN-IT
install pulls images and runs them; every runtime dependency is inside one. A GPU is optional and
its absence is a supported configuration, not a degraded one.

### The channel is an install-time parameter, not a later setting

Step 3 resolves a channel because a module customer does not run the public images:
`serialized-chasing-thacker`'s delivery matrix gives a paid-module install per-customer prebuilt
images and an own-module install a `haive-builder` it runs locally. An installer that always fetches
the public manifest hands a paying customer a stack with none of their modules and no error — the
same defect `steadfast-committing-gray` already closed on the UPGRADE side by making its release
manifest per-channel, and it must be closed on the INSTALL side too or the first run is wrong before
any upgrade happens.

- `--channel <id>` (default `public`), with the customer's identifier and any credential the
  per-customer registry needs. The one-liner keeps its shape: a module-free install types the
  documented line unchanged.
- An own-module install additionally pulls `haive-builder` and runs the one-shot build before step 6,
  since there are no prebuilt images to bring up. That is the same build the upgrade's Phase 0 runs,
  so it is one mechanism invoked at two moments, not two.
- A channel that does not resolve FAILS at preflight, next to the other prerequisite checks. Falling
  back to `public` would produce a stack that boots green and is silently the wrong one.

## Platforms — macOS is first-class for RUN-IT

RUN-IT and DEV-IT have different substrate rules and this section is about RUN-IT only. AGENTS.md's
"WSL2 plus Docker is the only supported developer environment" scopes itself to the DEVELOPER
environment; a published-image install builds nothing and needs no workspace, so it is not bound by
that constraint. Windows-native (non-WSL2) stays out of scope regardless — see below.

- **macOS needs no PowerShell.** It ships `curl` and `bash`, so the documented
  `curl -fsSL https://get.haive.dev | sh` line is byte-identical to the Linux one. The
  `irm | iex` sibling is Windows-only. Mac is the cheapest of the three targets for the installer,
  and its risks are all downstream of it.
- **No GPU on Apple Silicon.** Docker Desktop cannot pass the GPU to a container, so in-stack Ollama
  is CPU-only there. Step 5 already handles this — the same CPU/cloud-Ollama fallback a laptop
  without an NVIDIA runtime takes — so it costs no new branch, only accurate copy.
- **arm64 must be verified per base image, not assumed.** What is already known: nothing in
  `docker-compose*.yml` pins `platform:`, so images resolve to host arch rather than being forced to
  amd64; the sandbox base is `node:24-bookworm-slim`, glibc rather than musl because antigravity's
  `agy` is a dynamically linked glibc binary with no musl build; and
  `packages/worker/sandbox-image/Dockerfile:49-59` already carries an arch switch, installing rtk
  only on `x86_64` and stating that "aarch64 has no asset, so we skip cleanly on non-x86_64". clawker
  is absent from the shipped image (no `CLAWKER_RELEASE_URL`), so it is not an arch blocker either.
  The genuine unknown is the per-CLI binaries the image-composer layers on at compose time, which is
  measurable per adapter and belongs in the verification below rather than in an assumption here.
- **Windows needs Docker Desktop, NOT a WSL2 shell.** This corrects the plan's original claim.
  Docker Desktop uses WSL2 as its ENGINE, but that is its plumbing, not a requirement on how the
  user works: `docker` and `docker compose` run from PowerShell, no WSL distro is needed, and
  nothing is typed inside one. That is what makes the `irm | iex` installer coherent rather than a
  contradiction. AGENTS.md's "WSL2 plus Docker is the only supported developer environment" is
  about DEV-IT — bash `scripts/dev.sh`, the `.:/app` bind mount and its uid/chown dance, pnpm on
  the host — none of which a published-image install performs.

  Two things the installer must handle there, both from `docker-compose.yml`'s only two host binds:

  - **`${HOST_REPO_ROOT:-${HOME}}:/host-fs:ro`.** PowerShell does not set `HOME` (it sets
    `USERPROFILE`), so the default resolves to EMPTY and compose fails on a malformed mount. The
    installer writes `HOST_REPO_ROOT` explicitly, in a form Docker Desktop accepts, and the path
    must be one Docker Desktop is permitted to share. This mount is a convenience — a read-only
    view used to import a repository that already exists on disk — so an install that cannot share
    a path is degraded, not broken, and should say which feature it loses rather than refusing.
  - **`/var/run/docker.sock`.** Docker Desktop does expose it to Linux containers, so the worker's
    container spawning works unchanged; `DOCKER_SOCKET` is already parameterised if a given setup
    needs another path. The host-root disclosure this plan owes the user applies identically here.

  **MEASURED 2026-09-08** against Docker Desktop 29.7.2 / Compose v5.5.0, driving Windows
  PowerShell from WSL (`powershell.exe -NoProfile`), so these are results rather than reasoning:

  - `docker` and `docker compose` answer natively from PowerShell — server 29.7.2, linux
    containers. Preflight passes on Windows with no WSL distro involved.
  - `$env:HOME` really is **not set** (PowerShell's `$HOME` is a shell variable, not an environment
    variable, and Compose reads the environment). The default mount then fails HARD, not softly:
    `The "HOME" variable is not set. Defaulting to a blank string.` followed by
    `invalid spec: :/host-fs:ro: empty section between colons`. The stack cannot start.
  - Setting `HOST_REPO_ROOT` fixes it, and BOTH path forms are accepted — `C:\Users\x` and
    `/c/Users/x`. A container mounted at the native form listed the directory's real contents, so
    Docker Desktop's file sharing permits it without extra configuration for a path under the user
    profile.
  - **The Docker socket passes through.** A Linux container run with
    `-v /var/run/docker.sock:/var/run/docker.sock` reached the daemon and reported its server
    version, exit 0. The worker's container spawning needs nothing special here.

  **The full stack was then booted on Windows, 2026-09-08, from published v0.1.0/v0.1.1 images.**
  It works. With the dev stack stopped, `docker compose -f docker-compose.yml -f
  docker-compose.run.yml up -d web` from PowerShell brought up postgres, redis, db-migrate, api and
  web (the worker was deliberately left out — see below):

  - `db-migrate` ran BEFORE api started, exactly as the gate intends, classified the database
    `fresh` and applied the baseline in 139 ms. That is the fresh-install path proven from a
    published image rather than from source, which nothing had done before.
  - Re-pointing `HAIVE_VERSION` at the next release and bringing it up again classified `managed`
    and applied nothing — idempotent on Windows too.
  - `GET /version` reported the release version with `devBuild: false`; `/login` served HTTP 200;
    register, login and an authenticated read all succeeded, which exercises the database, the
    envelope encryption under a freshly generated `CONFIG_ENCRYPTION_KEY`, and JWT signing.

  Two things worth carrying forward. The WORKER was excluded on purpose: its boot reapers are
  database-driven, so a second install with an empty database sees every existing per-task auth
  volume as an orphan. Verified the blast radius first — the reaper filters strictly on
  `haive_cli_auth_task_`, so persistent per-user login volumes are never at risk — but an install
  test does not need the worker to prove the install. And teardown must NEVER use `down -v`: the
  project-scoped volumes are safe to drop, while `haive_repos` and four siblings are globally named
  and shared with the dev stack, so `-v` would take the machine's cloned repositories with it.

  Still untested: a local-path repository importing end to end through `/host-fs`.

- **Bind-mount throughput is lower on macOS** (VirtioFS) for the repo volume and node_modules. A
  documented expectation, not a blocker.

## The no-terminal path — a Docker Desktop Extension, not a double-click script

The audience for a one-line install already has Docker, because preflight requires it. Someone who
has never opened a terminal has not installed Docker Engine, but very plausibly HAS installed Docker
Desktop, which is a GUI installer. That is the opening, and it decides the shape of the answer.

- **A downloadable double-click script is rejected.** Unsigned, macOS Gatekeeper refuses a
  `.command` and Windows blocks a `.ps1` by execution policy while SmartScreen flags an unsigned
  binary — so the user meets a security scare dialog instead of a command, which is WORSE than
  typing one line, not better. Signing removes the dialog and costs an Apple Developer ID plus a
  Windows certificate, annually, for a path the one-liner already serves. Reconsider only if code
  signing is being paid for anyway.
- **A Docker Desktop Extension is the real no-terminal path.** It installs in one click from inside
  the application the user already has, runs the compose stack, and needs no shell at all. Its
  limits are honest: Docker Desktop only, so it does not serve a Linux server install, and it adds a
  packaging and publishing surface. Treat its capabilities as needing confirmation against the
  current Extensions SDK before committing — nothing here has been verified against it.
- The trust argument points the same way. This plan already requires the installer to state that the
  worker mounts the Docker socket and that this is host-root-equivalent. A user who cannot open a
  terminal is exactly the user least able to weigh that, and an Extension at least frames the
  decision inside Docker's own install flow rather than a piped shell script.

Sequencing: the one-liner ships first and is the documented path. The Extension is a separate,
later piece of work that reuses the same compose bundle and the same first-run setup, adding a
surface rather than a second installer.

## Two installs on one machine — NOT possible today

Worth stating before someone tries it, because the failure is not a clean refusal. Compose gives
each project its own namespace, but this stack overrides that in three places, all of which are
GLOBAL to the daemon:

- every service sets an explicit `container_name` (`haive-api`, `haive-postgres`, …);
- all three networks set an explicit `name:`;
- six volumes set an explicit `name:` — including `haive_repos`.

Containers and networks would collide, which is loud. The volumes would SILENTLY SHARE, which is
not: a second install would mount the first one's cloned repositories and its worker would act on
them. That is the part that makes "just try it" a bad idea.

The fix has its own plan — `solitary-partitioning-lampson`, the next priority after
`steadfast-committing-gray` — because it is wider than these three: the worker also constructs
sandbox containers, auth and IDE volumes, runtime runners and the RAG/global-KB DATABASE names in
code, and several reapers select what to delete by matching those same prefixes. A per-INSTALL id
defaulting to today's names keeps an existing install byte-identical. **Not a version in the
name** — the name must identify the install, not what it currently runs, or every upgrade renames
every container and a rollback renames them back, breaking anything holding a name and cutting logs
and monitoring in half at each release. The version already lives in the image tag and at
`/version`, which is where a changing value belongs.

**RESOLVED 2026-09-08.** `lampson` S0-S3 shipped, so this is no longer a limitation: pass
`--install-id <id>` (`-InstallId` on Windows) and the second install names its own containers,
volumes, networks, images and databases. The installer writes it to `.env` as `HAIVE_INSTALL_ID`
and uses it for `COMPOSE_PROJECT_NAME` too. Omitting it gives `haive`, which is byte-identical to
what shipped — so an existing install is unchanged.

One correction to the uninstall section below, forced by the same facts: `docker compose down -v`
is WRONG while any install shares this machine. Five volumes carry an explicit global `name:`, so
`-v` from one install takes the other's cloned repositories with it. The generated `uninstall.sh` /
`uninstall.ps1` removes only the project-scoped volumes and NAMES the shared ones rather than
touching them.

## First-run setup — the part that does not exist yet

> Detailed in its own plan: `anointing-gatekeeping-ibex` (first-admin onboarding + registration
> gating). That plan owns the auth/user model; this section is the installer's view of it. VERIFIED
> against the tree: `POST /auth/register` is open and makes every user a `'user'`, there is no
> first-admin bootstrap, and the web already has a `(auth)/register` page — so the gap is real.

`bootstrap.ts` bootstraps signing secrets, and `auth.ts` has `/login`, but there is NO first-admin
creation flow: a fresh DB has no users, so the app opens to a login wall with no way in. The
installer's UX hinges on closing this:

- Add a first-run guard in the api: when `users` is empty, `POST /auth/setup` is open (creates the
  first admin, sets a password) and every other route redirects the web to a `/setup` page. Once a
  user exists, `/auth/setup` is permanently closed (409). This is the analog of dsh "asks for an API
  key" — Haive asks for a first admin and the CLI provider credentials it will use.
- The web `/setup` page collects: admin email + password, and optionally a first CLI provider
  (paste an API key or defer to the in-app CLI login flow that already exists). Reuse `FormRenderer`
  and the existing CLI provider forms; no bespoke UI.
- The installer can pre-seed the admin non-interactively with `--admin-email`/`--admin-password` for
  scripted installs, printing a one-time setup URL otherwise.

## Security — the one thing that must not be gotten wrong

- **Never ship a default `CONFIG_ENCRYPTION_KEY`.** It is the master KEK for all envelope-encrypted
  secrets; a shipped default means every install shares an encryption key and any user can decrypt
  any other's secrets. The installer MUST generate a fresh random key per install and store it only
  in the local `.env`. If key generation fails (no `openssl`, no `/dev/urandom`), the installer
  aborts rather than falling back to anything predictable.
- **State the Docker-socket-root implication in the installer output**, not just the README. The
  worker mounts `/var/run/docker.sock`; running Haive grants it host-root-equivalent access. A
  one-line installer that hides this is dishonest. Offer the rootless-Docker path (Phase 9 hardening
  in the main roadmap) as the alternative, linked from the installer's final message.
- The `curl | sh` pattern is itself a trust decision. Publish the script over HTTPS with SRI-style
  pinning where the package manager allows it, and document the "download, read, then run" path for
  users who (correctly) do not pipe curl into sh blind.

## Prerequisites this plan depends on

- A CI pipeline that builds and pushes versioned, multi-arch api/worker/web images to a public
  registry (GHCR) on release. This is the bulk of the work and is a sibling of the private-registry
  auth the module plan (`serialized-chasing-thacker`) already sets up — same registry mechanics,
  public scope. Without it, RUN-IT has nothing to pull.
- The compose `run` overlay that swaps `build:` for `image:` at pinned tags.
- The first-run setup flow above.
- **Only for a non-public channel:** the per-channel release manifest (`steadfast-committing-gray`)
  and, for an own-module install, the `haive-builder` image (`serialized-chasing-thacker`). A
  `public`-channel install — the default and the one this plan is written for — needs neither, so
  neither gates shipping the one-liner.

## Rollback / uninstall (write the undo before the change)

The installer's whole footprint is one directory plus a compose project — nothing is installed
system-wide, there is no package to purge and no host path outside the install dir to clean. It
writes `uninstall.sh` (`uninstall.ps1` on Windows) beside the compose bundle, and that script
removes THIS install and nothing else on the machine.

**`docker compose down -v` is the wrong undo and this plan used to prescribe it.** Two reasons,
both measured. Six volumes carry an explicit `name:`, so before per-install naming `-v` from one
install took another's cloned repositories with it — and even now `-v` cannot tell runtime state
from work. And `down` does not reach the containers the WORKER creates: they are plain
`docker run`, outside the compose project, so `down` neither stops nor removes them and reports
`resource is still in use` while leaving the project network behind. MEASURED on a real install:
one such container (`<id>-ddev-registry`) at every teardown.

So the script is ordered `down` → sweep `^<id>-` strays → remove any network they were holding.
`down` runs FIRST rather than last, deliberately: a default uninstall KEEPS the work volumes and
a worker can be mid-write to one, so compose stops its own services cleanly instead of having
them killed underneath it.

Two modes, because "uninstall the app" and "delete my repositories" are different intentions and
only one of them is reversible:

- default — the stack, the project networks, and the four runtime volumes (postgres, redis,
  mailpit, ollama). Cloned repositories, uploaded bundles, CLI logins and the DDEV CA are KEPT
  and listed by name.
- `--purge` / `-Purge` — the above plus those work volumes, the per-task auth and IDE volumes,
  and the images this install BUILT.

`--yes` / `-Yes` skips the confirmation, which otherwise requires typing the install id back.

**Images are enumerated, never matched with a `<id>-*` wildcard.** On the default id that glob
also matches `haive-api`, `haive-worker` and `haive-web` — which is exactly what a source
checkout's compose build is called, so a wildcard purge would delete a developer's stack images
from underneath them. Only `<id>-cli-sandbox`, `<id>-sandbox`, `<id>-ddev-runner` and the
`<id>-env-*` prefix are this install's to remove. The pulled release images are shared between
installs and are left alone.

The install DIRECTORY is not removed by the script — it holds the script — and the final message
prints the one command that does. `.env` is never deleted while volumes survive, because
`CONFIG_ENCRYPTION_KEY` is what makes them readable.

VERIFIED end to end on both platforms 2026-09-09: install → boot → uninstall (default), then
`--purge`; zero containers, volumes, networks or images left, and the co-resident dev stack's
containers, volumes and images untouched.

## Verification

1. On a clean machine with only Docker + WSL2, the one command boots the full stack green, generates
   a unique `CONFIG_ENCRYPTION_KEY`, runs migrations, and opens the app at a working `/setup`.
2. First-admin creation works; `/auth/setup` then returns 409 forever.
3. A second install in a different dir generates a DIFFERENT encryption key (proves per-install key
   generation, the security-critical property).
4. No-GPU machine: boots on the CPU overlay with a working (small local or cloud) Ollama, no NVIDIA
   runtime required.
5. `uninstall.sh` returns the machine to its pre-install state (no leftover containers, volumes, or
   the install dir).
6. `docker history` on the published images reveals no baked secret (the key is generated at install
   time, never in an image).
7. macOS (Apple Silicon): the same `curl | sh` line boots the stack green with no PowerShell and no
   NVIDIA runtime, on CPU Ollama. Every base image resolves an arm64 manifest — enumerated per image,
   since nothing pins `platform:` and an amd64-only base would silently emulate or fail to pull.
8. macOS: each CLI adapter the image-composer can layer either installs and runs on arm64 or is
   reported as unavailable there with a named reason. rtk is the known-good precedent — it skips
   cleanly on non-x86_64 today — so the check is whether the others behave that way or break.
9. Channel: `--channel <id>` for a paid-module customer installs their per-customer images and their
   modules load (`GET /admin/modules/loaded` lists them); an own-module install pulls
   `haive-builder`, builds locally and boots those images; a channel that does not resolve fails at
   preflight and never falls back to `public`.
10. Version: `--version 0.1.0` installs exactly that release and `.env` ends up holding `0.1.0`, not
    an alias; `--version next` resolves a prerelease and still pins the concrete version it found; a
    version that does not exist fails at preflight with nothing written and nothing pulled.
11. Prerequisites: on a machine with no Docker, the installer names the missing piece and the exact
    fix for that platform and stops, having changed nothing. `--check` does the same on a healthy
    machine and reports it is ready.

## As built — what running it on two platforms changed

Verified 2026-09-08 against published v0.1.3/v0.1.4/v0.1.5 images: a Linux/WSL install, a
PowerShell install on Windows, and a second Linux install running BESIDE a dev checkout. Three
Haive installs coexisted on one machine, and the same daemon served all three — Docker Desktop's
WSL2 integration means PowerShell and WSL drive ONE daemon (identical `docker info --format
'{{.ID}}'`), so "a Windows install and a WSL install" are two installs on one daemon and it is
`--install-id`, not the shell, that separates them.

Three defects, none visible from reading the plan and each found by running it:

- **The installer silently adopted another install's database.** Postgres applies
  `POSTGRES_PASSWORD` only when it INITIALISES an empty data directory, so a fresh install pointed
  at an existing `haive_postgres_data` does not re-key it. MEASURED: the install failed with
  `password authentication failed for user "haive"` after adopting a volume created months earlier
  by a dev stack — and the failure was the LUCKY outcome. Had the passwords matched, a "fresh
  install" would have come up on someone else's live database, with their tasks, repositories and
  secrets in it, and said nothing. Preflight now refuses an install id that already owns a Postgres
  volume or an api container on this machine, and names `--install-id` as the fix.
- **The default ports collide in practice, not in theory.** Haive pins DDEV's global mailpit to
  8025-8026, so any machine that has run a Haive-managed DDEV project already holds the default
  mailpit port — MEASURED, `ddev-router` publishing `127.0.0.1:8025-8026`, and the first install
  attempt died on it. All three ports are probed now (`ss` where present, docker's published-port
  list otherwise; `Get-NetTCPConnection` on Windows). The three installs took 3000/3001,
  3002/3003 and 3004/3005 without being told to.
- **PowerShell turns a native command's stderr into a terminating error** under
  `$ErrorActionPreference = 'Stop'`, even when the command succeeds. MEASURED: `docker info` prints
  `WARNING: No blkio throttle.read_bps_device support` and exits 0, and the installer died in
  preflight on a perfectly healthy Docker Desktop. Every native call now goes through one
  `Invoke-Native` helper that relaxes the preference and returns the exit code.

Two things the plan flagged as unknown are now measured. `HOST_REPO_ROOT=C:\Users\<user>` works:
`/host-fs` inside the container lists the real user profile, so the native Windows path form needs
no translation for this mount. And a `C:\` install directory resolves correctly as a `docker run
-v` bind mount, which is what the in-app updater hands the daemon — so the Windows upgrade
plumbing is sound (`canUpgrade: true`, and the mount was verified directly).

Verification items 1, 3, 5, 10 and 11 are met; 2 waits on first-admin bootstrap, 4 and 7-9 are
untested (no non-NVIDIA-less host, no Mac, no non-public channel). One gap worth naming: a fresh
install still opens to a login wall, because `POST /auth/setup` does not exist yet — every test
above had to promote its first user with SQL.

## Out of scope

- A hosted/cloud Haive (this is local-first, matching dsh's "no account, no cloud session").
- Auto-update of a running install. The follow-up this named now exists as its own plan:
  `steadfast-committing-gray` owns `haive upgrade`, the transactional apply, maintenance mode and
  the per-channel release manifest. Still not this plan; the pinned-tag compose bundle is the shared
  prerequisite.
- Windows without Docker Desktop. Windows-native RUN-IT via Docker Desktop is IN scope — see
  Platforms, which corrects the earlier claim that WSL2 was required of the user. macOS and Linux
  are first-class too. None of this widens AGENTS.md's constraint, which scopes itself to the
  DEVELOPER environment, where WSL2 genuinely is required.
- The Docker Desktop Extension itself. Chosen as the no-terminal path above, sequenced after the
  one-liner, and reusing this plan's compose bundle and first-run setup rather than forking them.
