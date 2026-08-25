# One-line install for Haive

> Status: PROPOSED, 2026-08-25. Prompted by the DeepSeek `dsh` harness (harness.pdf), whose entire
> install is `npx @deepseek-ai/dsh web` — a browser tab opens, asks for an API key, and a full
> harness is running locally with no account and no cloud session. This plan asks what the
> equivalent is for Haive, and is honest that Haive is a heavier thing than a single Node process.

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

## Shape of the command

`curl -fsSL https://get.haive.dev | sh` (and a `powershell -c "irm get.haive.dev/install.ps1 | iex"`
sibling), or `npx create-haive`. All three do the same bootstrap:

1. Preflight: Docker Engine + Compose v2 present and the daemon reachable; WSL2 when on Windows (the
   project's only supported substrate); enough free RAM and disk for the stack's reserve budget.
   Fail with a specific fix per missing prerequisite, never a stack trace.
2. Pick an install dir (default `~/haive`), refuse to clobber a non-empty one without `--force`.
3. Fetch the versioned compose bundle for a pinned release: `docker-compose.yml` plus a
   `docker-compose.run.yml` overlay that references `image:` tags instead of `build:` contexts. NOT
   the source tree.
4. Generate secrets into `.env`: `CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)`, a random DB
   password, SMTP left at Mailpit. This is the security-critical step — see below.
5. GPU detection: probe for an NVIDIA runtime and select the GPU overlay; otherwise default to
   CPU, and default Ollama to a small local model or to cloud Ollama, so a laptop without a GPU
   still boots. (Mirror the GPU layering `scripts/dev.sh` already does.)
6. `docker compose ... up -d`, pulling published images. Run the DB-migrate one-shot (the dev
   override already has this shape) before api/worker accept traffic.
7. Wait for `/health`, then hand off to first-run setup (below) and open `http://localhost:3000`.

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

## Rollback / uninstall (write the undo before the change)

The installer's whole footprint is one directory plus a compose project. Uninstall is
`docker compose -p haive down -v` (removes containers, networks, and the named volumes —
`haive_repos`, postgres, redis) followed by removing the install dir. The installer writes an
`uninstall.sh` that does exactly this, and its final message names it. Nothing is installed
system-wide; there is no package to purge and no host path outside the install dir to clean.

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

## Out of scope

- A hosted/cloud Haive (this is local-first, matching dsh's "no account, no cloud session").
- Auto-update of a running install (name it as a follow-up: the pinned-tag compose bundle makes
  `haive upgrade` a later, well-defined step, but it is not this plan).
- Windows-native (non-WSL2) install — the project's supported substrate is WSL2 + Docker only.
