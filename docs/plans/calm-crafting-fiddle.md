# T335 — channel install and upgrade (plan D2b)

> **SHIPPED — T335, 2026-11-05; re-verified in the tree 2026-11-12.** PR A #1007
> (`4d4193768`), B #1008 (`d71934772`), C #1009 (`d94aafc00`). The builder/release image,
> updater channel path and both installers exist. [Modules](../architecture/modules.md)
> “Installing a channel” / “Upgrading a channel install” records the as-built validation,
> credentials and image pins; the original public-byte-identity promise below predates
> necessary public-path fixes. Follow-ups are T533/T538/T539 and their successor board entries,
> not unimplemented A/B/C slices. Do not execute this plan again.

## Context

T351/T353/T352 build, boot-check and publish a per-customer channel (`haive-<channel>-{api,worker,web}`
pinned by digest, `release.json` written locally only). Nothing consumes it yet:

- `install/install.sh:274` and `install.ps1` refuse any channel but `public`.
- The manifest URL is a GitHub release literal in three places: installer `:284`, the generated
  `./haive upgrade` (`install.sh:428`), and api `routes/maintenance.ts:429` (`HAIVE_RELEASE_MANIFEST_URL`).
- The updater composes `${registry}/haive-<host>:<version>` (`packages/updater/src/images.ts:38-44`)
  and ignores manifest `images`; `prepareImages` refuses image overrides without own modules (:86-90).
- No pull credential exists on a customer host; per-customer registries are private.
- The paid+own cell (serialized-chasing-thacker delivery matrix) needs a per-customer `haive-builder`,
  which T352 does not build or publish.

User decisions 2026-11-05:
- The channel manifest lives IN the channel registry (one credential reaches manifest and images).
- T335 builds and publishes the per-customer builder.
- install.sh and install.ps1 change together.

Outcome: `install.sh --channel acme` installs acme's pinned images from a private registry with an
install-local credential; every later upgrade (admin page or `./haive upgrade`) reads acme's manifest,
never the public one; an acme install carrying own modules rebuilds on acme's builder. The public
one-liner and public upgrades are byte-for-byte unchanged in behaviour.

## Shape (stable contracts)

- Channel repos: `<channelRegistry>/haive-<channel>-{api,worker,web,builder,release}`.
  `channelRegistry` defaults to `ghcr.io/martinambrus` (build-channel's default destination).
- Manifest image `haive-<channel>-release:<version>`: `FROM scratch`, one file `/release.json`,
  label `org.haive.release=1`. Read by `docker create` + `docker cp` + `docker rm` (no ORAS, uses the
  same docker auth as every pull). Tag-absence proof from publish-channel applies to it too.
- `releaseImagesSchema` gains optional `builder` (additive; older parsers strip it).
- `.env` keys (new, all optional, absent = public): `HAIVE_CHANNEL`, `HAIVE_CHANNEL_REGISTRY`,
  `DOCKER_CONFIG=<install>/.docker`. Images still go through the existing `HAIVE_*_IMAGE` overrides,
  set to the manifest's pinned refs. `HAIVE_REGISTRY` stays public (updater, proxies, postgres etc.
  are not per-customer).
- Credential: install-local `<install>/.docker/` (0700) with `config.json` (0600), written by
  `docker login --password-stdin` under `DOCKER_CONFIG`. Token from `HAIVE_REGISTRY_TOKEN` env or a
  no-echo prompt, never argv; `--registry-user <u>`. No credsStore in that config. Revocation = the
  vendor revokes the token; the next pull fails closed; the running stack keeps running (stated in docs).
- Fail closed everywhere: a non-public channel whose manifest image cannot be pulled, whose
  `channel`/`version` disagree with the request, or whose required image is missing refuses at
  preflight. Never fall back to public.

## Slices — three PRs, in order, one Codex run + Sonnet review each

### PR A — build and publish the builder and the manifest image (scripts + shared schema)

- `scripts/build-channel.mjs`: also build `docker/own-module-builder/Dockerfile` from the same prepared
  tree (same `--secret id=npmrc`, platform, `HAIVE_VERSION`) as `haive-<channel>-builder:<version>`;
  record it as `images.builder` (`built: true`, `id`). Always built: a channel install may add own
  modules later.
- `scripts/channel-gate.mjs`: scan the builder image with the same entitled-set leak check
  (`/app/modules`, `/app/node_modules/@haive-module/*`, host package.json deps) and the no-token check.
  Leakage in the builder is the same irreversible defect as in api/worker.
- `scripts/publish-channel.mjs`: push builder with the others; manifest `images.builder` pinned ref;
  then build and push `haive-<channel>-release:<version>` LAST (after the local `release.json`
  write), with the same absence proof and digest re-read. Exit codes unchanged.
- `packages/shared/src/release/manifest.ts`: `builder` optional; `scripts/build-release-manifest.mjs`
  untouched for public (no builder key needed; public builder keeps its tag-composed ref).
- Reuse: `capture`/`run`, `parseRecord`, absence proof, `DAEMON_NOT_FOUND` constant.

### PR B — the updater and the api read the channel

- `packages/updater/src/cli.ts`: new `--manifest-image <ref>` (mutually exclusive with `--manifest`);
  `loadManifest` gains the docker create/cp path (temp container named by the existing naming helper,
  always removed); check `manifest.channel === --channel` and `manifest.version === target`.
- `packages/updater/src/images.ts`: `prepareImages(..., channelImages?)`:
  - channel install without own modules: return overrides = manifest pinned api/worker/web (pulled
    via compose with those overrides); allow overrides on the current install when `HAIVE_CHANNEL`
    is non-public (replaces the :86-90 refusal for that case only).
  - channel install with own modules: `baseImages` = manifest api/worker/web, `builderImage` =
    manifest `builder`; refuse when `builder` is absent. Output local tags as today.
  - public: unchanged code path.
- `packages/updater/src/cli.ts:183`: `currentImages` already honours overrides; keep.
- `packages/api/src/routes/maintenance.ts` POST /upgrade: when `HAIVE_CHANNEL` is non-public, pass
  `--channel` and `--manifest-image ${HAIVE_CHANNEL_REGISTRY}/haive-${channel}-release:${version}`
  instead of `--manifest`, plus `-e DOCKER_CONFIG=/install/.docker` (install dir already mounted).
  Names only in argv, never a token. `docker-compose.run.yml` passes the three keys to api.
- Readers: `maintenance.ts` GET /upgrade reports `channel` (display only).

### PR C — installers

- `install/install.sh` and `install/install.ps1` (same flags, same behaviour):
  - `--channel <id>` (CHANNEL regex as build-channel), `--channel-registry <prefix>` (PREFIX regex),
    `--registry-user <u>`; token from `HAIVE_REGISTRY_TOKEN` or prompt.
  - Non-public: create `<install>/.docker`, `docker login`, pull the manifest image for the resolved
    version, validate it, write `HAIVE_CHANNEL`, `HAIVE_CHANNEL_REGISTRY`, `DOCKER_CONFIG`, and the
    three `HAIVE_*_IMAGE` pinned refs to `.env`. `--check` performs login + manifest read and writes
    nothing outside a temp DOCKER_CONFIG it removes.
  - Generated `./haive`: export `DOCKER_CONFIG` from `.env` for `up`/`pull`; `upgrade` uses
    `--manifest-image` + `--channel` + `-e DOCKER_CONFIG=/install/.docker` when the channel is non-public.
  - Uninstall script also removes `<install>/.docker` (it holds the credential).
  - Public path: no new prompts, identical `.env` (assert by diffing against current output).

## Rollback

All additive. Revert each PR independently, newest first.
- PR C reverted: new installs refuse channels again; existing channel installs keep running; their
  `./haive` wrapper is already written.
- PR B reverted: an older updater on a channel install refuses (`image overrides require
  HAIVE_OWN_MODULES_HOST_DIR`) — fails closed, nothing changes. Recovery: re-apply PR B.
- PR A reverted: channel builds stop producing builder/manifest images; already-published tags stay
  (registry tags are not deleted by a revert).
- No database migration in any slice.

## Verification

Per slice: controls first (red then green), touched test files, `node --test scripts/test/*.test.mjs`,
updater/api/shared vitest for touched packages, `child-process-ratchet`, prettier.

Real checks (throwaway, 127.0.0.1, removed afterwards, never the dev stack or its ports):
- A: scratch clone `v9.9.9`, `registry:3` with htpasswd auth, build-channel (empty module list) →
  gate scans builder → publish → manifest image present; repeat publish exits 1/2.
- B: updater `--check` against that registry with a scratch DOCKER_CONFIG: channel manifest read,
  pinned overrides computed; wrong channel / missing manifest / no credential → refused. Own-module
  path: builder ref chosen from the manifest (dry plan).
- C: `install.sh --channel t335 --channel-registry 127.0.0.1:<port> --no-start --install-id t335x
  --dir <tmp>` with the htpasswd user; `.env` holds pinned refs; `DOCKER_CONFIG=... docker compose
  config` resolves them; `docker compose pull api worker web` succeeds with the install-local config
  and fails without it. Public `--check` output unchanged. ps1: run under `pwsh` if present on the
  host, else static parity review and say so.
- Feature end: full `pnpm test` once with main merged; CI green per PR.

## Docs (session writes)

- `docs/architecture/modules.md`: "Installing and upgrading a channel" after "Publishing a channel";
  update the Publish section for builder + manifest image.
- `docs/architecture/release.md` if it names the manifest URL; installer `--help`.
- Board: T335 done line; FNF by bundle (T533 for script items).
