# Sandbox

`packages/worker/src/sandbox/clawker-client.ts` wraps the clawker binary. The worker container mounts `/var/run/docker.sock` and uses Docker-in-Docker to spawn per-task containers. The cloned repository and the run-owned files described below are mounted into the per-task container. The worker filesystem and the user home directory are never exposed. CLI authentication files are copied into a named volume per task at startup and the volume is destroyed at task end. At worker boot `reapOrphanedAuthVolumes` removes a task's copy whose task ended, and an isolated provider's or a user's auth volumes once that row is gone, so a deleted provider or user leaves no CLI credential on the host. A login session still holding such a volume is removed with it, since its row went with the owner's and nothing else would. The owner is read back from the volume's name (`cliAuthVolumeOwner`, beside the builders).

**Committed mining views are immutable mounts.** `repo/committed-snapshot.ts` owns the bounded
resolver. `resolveInvocationRepoMount` chooses a snapshot before repository-less scratch,
read-only host-folder and integration-worktree branches and reports `workspaceKind: 'snapshot'`.
Only its target tree is mounted at `/haive/workdir`; an optional base tree is mounted separately
at `/haive/diff-base`. Both are read-only. Neither the scratch parent, inventory body nor object
repository is mounted. Every object is independently hashed; Git receives a held `.git` descriptor
through `runTool` as the unprivileged extraction uid, without ambient credentials or lazy fetch.

Materializers retain `withTaskScratchWorkspace` through their entire use. Dispatch retains
workerRoot and the verified tracked inventory in memory, taking the lock only while reading
persona bodies; MCP/global-KB/app-reach queries and codex probes run outside that section.
Exec acquisition happens after the durable invocation exists; that live row protects the mount
from scratch reaping after acquisition returns. A snapshot has no `.git` and bypasses writable-tree
repair, git-data preparation, `.haive-data`/worktrees overlays, uploads nesting and agent-directory
stub creation. Agent isolation is disabled for these views. Template personas read the same target
and its verified tracked inventory. House-rule file scopes conservatively cover the target/base
inventory union, never a live index. Snapshot runs clamp to `rag_only` (preserving `none`),
excluding live DDEV, browser, repository-defined, custom and integration MCP servers. Their
MCP configuration includes neither git nor LSP tools on plain or sub-agent execution paths.
RAG search answers from the live index, not the pinned snapshot; ground its hits against the
mounted bytes before using them as snapshot evidence. App reach explicitly
says the runtime serves the task's live tree, so it cannot validate the snapshot's contents.

The real read-only mount control runs in CI `compose-boot` inside the built worker image,
with a shared host-visible temporary path and a bounded wait for `haive-cli-sandbox:latest`.
It adds no GATED row (the list stays at 156). Local controls and static workflow pins do not
prove the Actions environment: only a PR run proves this wiring works, and it must pass before merge.

**A run sees only its own files.** `runInSandbox` writes a run's wrapper script and extra files (MCP
configs, the `haive-custom` and `haive-integrations` token files) into the shared wrappers volume under
the run's own directory and mounts each one by subpath at its sandbox path, read-only. The volume's
root is never mounted: a whole-volume mount let any sandbox list the volume and read the token file of
another live run, of any task or user. A plan-chat run also sees its own versioned snapshot at
`/haive/plan-chat-snapshot.json`: one read-only file subpath from a random directory under
`plan-chat-snapshots/` in that same volume, outside the checkout and `.haive-data`. The worker
checks its user, repository, task and invocation against the owned run before mounting. Its
pretty-printed JSON carries all nodes with bodies and read versions, plus edges and owner/schema
fields; the prompt explains searching by node id. Snapshot removal is awaited last in `finally`;
a failure logs at error and preserves both the run result and every other cleanup. Boot reaping
tries entries independently after CLI-container reaping, treats a missing directory as empty and
logs failures at error without stopping boot. See [Secret and git-data masking](sandbox-masking.md).

**The shared npm cache is read-only in a sandbox; each run seeds a private copy.** The `npm_cache`
volume keeps what `npx` fetched, so an MCP server such as chrome-devtools-mcp does not repeat a cold
fetch (MEASURED 111-146 s) in every `--rm` run. It used to be mounted read-write into every sandbox,
so one task's agent could plant cache content that another task's `npx` then used. `npmCacheMount()`
(`sandbox/npm-cache.ts`) now mounts it read-only at `NPM_CACHE_BASE_DIR`, and `NPM_CACHE_SEED_PRELUDE`
copies it into `NPM_CACHE_DIR` under `/tmp` before the command execs, with `npm_config_cache` pointing
there. The private copy lives in the container's writable layer and dies with the `--rm` container, so
it has no volume and no reap path. It is per invocation, not per task: what an agent itself fetches no
longer outlives its run (a per-task copy would need a second volume with its own create and teardown),
and the platform MCP servers are warmed into the base on every invocation instead. The seed costs
about 0.36 s at 47 MB and grows with the base. The prelude has no `set -e`: a failed seed writes a
warning to stderr and the command runs on a private cache that may be empty or partial, never on the
shared one. Both spawn sites carry it (`createSandboxSpawner` in `queues/cli-exec/exec-core.ts`,
`runStepCommandInSandbox` in `sandbox/step-command.ts`); a new site mounts `npmCacheMount()` only with
the prelude, and never read-write. Only the worker's warm, purge and align containers write the
volume, mounting it at `NPM_CACHE_DIR` so a tree is read back from the path it was installed at. npm's
hash check compares a blob with the index entry beside it, so it does not stop a writer of both: the
base is read-only rather than verified. The first align after the upgrade empties a volume written
while it was still read-write (`.haive-cache-ro-migrated`, written after the wipe so an interrupted
wipe runs again at the next boot), and the warm path refills it.

**The base image builds itself, and that is why there is no manual first-boot step.**
`haive-cli-sandbox:latest` is built from `packages/worker/sandbox-image/` and pushed to no
registry, so `docker image prune` — and a fresh checkout — leave docker resolving a
Docker Hub repository that does not exist, which is what "pull access denied" means here
and not an auth problem. `ensureSandboxCoreImage` (`sandbox/sandbox-core-image.ts`) is the
one builder: fire-and-forget at boot beside `ensureDdevCa` so a pruned host heals BEFORE
the first task, and again at every site that needs the image — the two build entry points
(`handleBuildSandboxImageJob`, `resolveBaseImageId`) plus the three that `docker run` the
base DIRECTLY (`runInSandbox`'s no-derived-image fallback, `ensureTaskAuthVolumes`,
`ensureIdeVolumes`). Deliberately NOT the three sites that swallow their own failure
(`usage-window/token-source.ts`, `npm-cache.ts`, the login chown helper) — a throwing call
inside a deliberately-silent path changes its contract, and they inherit the healed image
anyway. The in-flight promise is load-bearing rather than a boolean flag: cli-exec runs at
concurrency 5-7 and a flag set only on success lets every one of them start the same
multi-minute build.

**It also rebuilds itself when its definition changes.** The ensure used to build only a
MISSING image, so an install that had the base kept it through every release that changed it,
and an rtk bump reached fresh installs only. `sandboxCoreIdentity` hashes every file of the build
context and the rtk build args an operator pinned (`RTK_RELEASE_VERSION`,
`RTK_X86_64_MUSL_SHA256`, which compose hands the worker as well as the `cli-sandbox` build, or
the worker would rebuild a pinned image under the defaults); the build stamps it on the image
(`haive.core-identity`), and the ensure rebuilds an image carrying any other value, none
included: a hand-run `pnpm docker sandbox-build` and an image from before the label carry none,
so the worker rebuilds them once. Every per-CLI Dockerfile carries the same identity
(`LABEL haive.base-identity`, `image-cache.ts`), because its tag is a hash of its own text and
names the base as `:latest`: without it a per-CLI image built on the old base kept its tag and
went on being served. Its next use builds it on the new base. A failed rebuild throws, as a
failed build of a missing image does, so no per-CLI image is built on a base that is out of date
and then tagged as current. The base a rebuild replaces stays while a container or a per-CLI image
built on it still uses it; the boot sweep `reapSupersededSandboxCores`
(`sandbox-image-reaper.ts`) removes it, without `--force`, once neither does, and only when it also
carries this install's `haive.install` label: on a daemon shared by two installs, a dangling image
has lost the repository name that would say whose it is. One built before either label carries
none, so the sweep cannot prove its owner, and it stays (about one base image per install).

**rtk seeds a task's auth volume only with hooks the task's own image can run.**
`seedRtkInTaskVolume` runs `rtk init -g` from the base image, but a task can run another rtk: an
env-template image installs the repository's pin. A 1.0 seed writes codex a PreToolUse hook on
`rtk hook codex`, which 0.x rejects with exit 2 and a usage error on stderr, and codex takes that
as the hook blocking the tool call, so every shell command of a codex task pinned to 0.x would be
refused. `resolveAuthMounts` therefore takes the image the CLI runs in, and the seed first asks
that image (`imageRunsRtkHook`: `rtk hook <agent> --help`, by exit code, once per image). A CLI
whose image runs its hook is seeded; one whose image cannot has rtk taken back out
(`rtk init -g … --uninstall`, which removes only what its init wrote), since a seed for an
earlier image of the same task may have written the hook. The seed is recorded per image, the
slot's last-applied identity, because the image can change mid-task: a repository's rtk pin can
move, and the next invocation then composes another image. A failed removal is not recorded, so
the next invocation tries again.

Two consequences worth keeping. The ensure is a no-op whenever `SANDBOX_IMAGE` names
something other than the core tag, because building ours over an operator's pinned image
would silently replace it — the "missing image" failure is then correctly theirs to fix.
And `packages/worker/Dockerfile`'s production stage must keep copying `sandbox-image/` and
`docker/`: it otherwise ships only `dist`, which leaves both this self-heal and
`ensureDdevRunnerImage` with no build context on a deployed host.

**Builds of one image tag run once at a time.** Providers that resolve to one tag (the claude
family at one CLI version) each queued a `docker build` of it, and the builds ran side by side in
the light lane; each then removed the image the tag had named, which could be the one the other
had just built. `handleBuildSandboxImageJob` keeps the builds in flight by tag (`inFlightBuilds`):
a second provider joins the running build and does only its own bookkeeping, and the builder alone
removes the previous image. In-process is enough, since the queued jobs and the inline dispatch
build both run in the one worker compose pins, and a joiner holds its slot exactly as long as its
own build would have. Marking a shared tag ready skips every sibling still `building`
(`markProvidersReady`): that row has a build of its own queued or running, forced or not, and
reports its own result. A sibling's cache hit during a forced rebuild used to mark the rebuilding
provider ready and re-enable its Rebuild button while the build still ran. Joining the build in
flight could not close that, since the api sets `building` the moment Rebuild is clicked, before
any job exists to join.

**A provider's row names its image only once that image exists.** A build used to write its new tag
before building, so one that failed left the row naming an image that was never made, nothing named
the old one any more, and a later success removed the failed tag as "previous" while the old image
stayed for good. A build now writes only its status when it starts. On success one locked write
(`markProvidersReady`, its rows locked in id order) moves the provider, and on a shared tag every
sibling not still building, to the tag, each only while its config asks for that tag. It keys on
config, never on the tag a row names: a failed build leaves its row on the image it had, so a
sibling on this tag whose config has moved on keeps showing its own failure rather than being
marked ready on an image it no longer wants. It hands back the tags those rows named before, and
each goes through the removal check below. The claim is made in the
tag's turn (`withImageTagLock`) and only while the image stands, and every removal first waits out a
build of its tag running here: with the row no longer naming a tag while it is built, a provider
moving off that tag otherwise found it unnamed and removed it just before the build claimed it. A
build of a config the provider has since left moves nothing and records no failure on the row,
since the build of its new config owns it; its image goes unless a row names it, and its caller, an
inline dispatch included, hears the build as failed for that reason rather than running an image the
provider no longer asks for. Every write a build makes to its own row lands only while the
provider's config still asks for its tag (`writeWhileWanted`), its first included, so a build
already left when it starts builds nothing: an older build's `building` landing after a newer build
marked the row ready used to leave it `building` for good. A provider that stops needing an image has the one it named removed the
same way.

Deleting a provider removes the image it named. The api never touches Docker, so its DELETE queues
`REMOVE_SANDBOX_IMAGE` with the row's tag, and the worker removes the image through the same check a
rebuild's old image goes through (`removeOrphanedPreviousImage`): kept while any other provider
names the tag, and only once a build of that tag running here has ended, whatever it ended in, since
it may have been this provider's own. A build whose provider is gone once it ends, whatever it ended
in, removes both the tag it built and the one its provider named before, under the same check: a
provider deleted before its build registered left the removal nothing to wait for, and only the
build knew the tag it was replacing. That check and the removal take their
turn per tag with a build's cache hit (`withImageTagLock`): a removal that read no provider naming
the tag otherwise deleted the image a cache hit had just marked a provider ready on, and a rebuild
removing its old tag raced a sibling switching to that tag the same way. A removal that could not
be queued leaves the image, as every delete did before, and never fails the delete that already
happened.

A build and a removal of one tag never interleave: the builder runs `docker build` and makes its claim
inside one `withImageTagLock` turn, so a removal cannot fall between a cached build finishing and its
claim. At boot `reapOrphanedSandboxImages` (`sandbox/sandbox-image-reaper.ts`) removes the per-provider
images (`<repo>:<name>-<16 hex>`, never `:latest` or a composed image) that no provider names, through
the same check and turn and without `--force`, so docker refuses one a container uses and the refusal is only logged.

`cli_providers.sandbox_image_build_status` is reconciled against the real images on every
boot (`clearPrunedSandboxImageState`, `data-migrations.ts`). Not cosmetic: a stale `ready`
clears `createSandboxLoginContainer`'s gate and turns "not built" into `No such image`,
and a stuck `building` — which nothing else anywhere resets — DISABLES the Rebuild button
that is the only way out of it. Resetting `building` is safe there and only there, because
`runDataMigrations` runs before any queue starts and compose pins the worker to one
instance.

**Repository editors open the checkout directly.** The Repositories Actions menu links to
`/repos/<id>/editor` for ready, writable repositories, alongside Terminal. The page uses the
same `EditorTab` and code-server launcher as a task, but `POST /repos/:id/ensure-ide` sends a
repository payload to the worker and `/ide/repos/:id/` proxies its HTTP and WebSocket traffic.
Both transports require repository ownership; the worker checks ownership, readiness and writable
storage again before mounting exactly `<userId>/<repositoryId>` from the repos volume at
`/workspace`. A repository editor never resolves a task's worktree and never creates a task.
Read-only host imports remain unavailable; writable local imports copied into the volume work.

The shared `EditorTab` has a Maximize/Minimize control for both task and repository editors.
It requests browser fullscreen, with a viewport overlay when fullscreen is unavailable, and
keeps the same iframe mounted while resizing so the live session and unsaved buffers survive.

`repoIdeSessionId` gives repository editors a separate `repo-<uuid>` session namespace. Their
containers and user-data volumes use the full repository id, separate from task editor state;
extensions and global settings are still shared per user. The existing IDE refcount and 30-minute
idle reaper keep a connected editor alive and preserve unsaved buffers across reopening. Repository
deletion waits out a boot in progress, stops its editor, and removes its user-data volume and Redis
session through the worker's repository resource cleanup job. Repository editors keep the same
read-only git-data boundary as task editors (`repoGitDataBoundary`), since code-server extensions
and workspace tasks execute repository code; the repository Terminal remains the surface for git
commits and pushes.

**Editor lifecycle.** Every editor carries `haive.ide.spec`, its image plus the code-server flags
from one list (`IDE_SERVER_ARGS`, `sandbox/ide-runner.ts`). An ensure that finds a running editor
launched with another spec, or with none, keeps it while the session registry shows it in use and
replaces it once it is not. In use is `ideSessionHeld` (`sandbox/ide-session.ts`), the idle reaper's
own check: a socket attached (refcount above 0) or `lastSeenAt` within `IDE_IDLE_GRACE_MS` (30 min).
A registry that cannot be read counts as in use, and a spec that cannot be read is not stale, so a
stale editor keeps its launch while attached and for one grace after, and a replacement takes nothing
the reaper would not. Before replacing it the ensure makes sure `CODE_SERVER_IMAGE` is on the host
(inspect, else a pull bounded to 120 s) and keeps the old editor with a warning when it cannot be
had; the removal itself waits until the volumes and mounts are ready, right before `docker run`. An
editor holding another workspace is still recreated at once, whatever its use or image. A workspace
label that cannot be read (the `docker inspect` failed, `runnerSubpathVerdict` `'absent'`) is not
another workspace: the editor is kept, as the app runner is (both reuse on anything but `'other'`, a
different or empty label), and the next ensure whose inspect succeeds decides. Whether an app runner, an editor or the DDEV registry mirror exists, and runs, is read by
`probeRunner` (`runner-probe.ts`): one `docker ps -a --no-trunc --filter name=^/<name>$ --format
{{.State}}`, where exit 0 with no output is absent, one known state is present, and anything else
(a non-zero exit, a timeout, an unknown state, more than one line) is unknown. No Docker error text
is read, so a reworded message cannot turn a failure into "absent" (MEASURED on Docker 29.9.2 and
29.9.3: an exact name prints its state, a missing or partial name prints nothing, all exit 0). An
unknown answer never recreates or removes a runner, never clears its browser surcharge, and keeps
editor sessions, their user-data volumes and a repository's cleanup row for a later retry; the
same holds when the editor's ownership label cannot be read. `lastSeenAt`
is written by the api on attach and detach and by the worker on every ensure (task and repository)
and before every launch, so a task editor no socket ever reached is reaped as well. The reaper's sweep also lists this
install's running editors (`listIdeRunnerSessions`: `label=haive.ide`, the session id read off the
`haive.task.id` or `haive.repo.id` label, kept only where `ideRunnerName(session)` is the container's
own name, since the name keeps 8 characters of a task id and an editor from before the install label
has none) and
writes `lastSeenAt` = now (`HSETNX`) for each without one: an editor with no entry is held one grace
and then reaped by the same `ideSessionHeld` rule, never read as idle for lacking an entry. One
launched before the spec label is stale, so it keeps its launch for that grace too. On boot the api
zeroes every refcount, gives a session that was held `lastSeenAt` = now (its tab is about to
reconnect) and leaves an idle one's age; the terminal-shell registry is reset the same way. A
docker-level launch option added later must join the spec: `IDE_SERVER_ARGS` covers only what follows
the image. The debug setup after boot (PHP debugger install, forwards) is best-effort, its task
lookup included: a lookup that fails is logged and skips it, and the ensure still succeeds.

**The editor runs on its own origin with its own session.** code-server runs repository code, so
nothing it serves may act with the app's authority. The editor origin is `HAIVE_EDITOR_ORIGIN`, else the
api's public origin (`editorOrigin`, `api/src/lib/request-origin.ts`); both the api and the web read it,
so compose passes it to both (the web needs it for its `frame-src`). A configured origin on the app's
hostname is refused at boot unless it equals the default, because a browser sends a hostname's cookies to
every port. The web never relays `/ide`: `apiProxyTarget` refuses a first path segment that decodes to
`ide`, as Hono decodes it, so `/api/haive/%69de/...` is refused too. Opening an editor:

1. `EditorTab` polls `POST /tasks/:id/ensure-ide` (or `/repos/:id/ensure-ide`) until ready.
2. It asks for one grant per iframe load, `POST /tasks/:id/editor-handshake` (`lib/editor-grants.ts`):
   a 32-byte secret stored in Redis for 60 s (`editor-grant:<sha256>`), answered as
   `<editor origin>/ide/_handshake#<secret>`. A 409 is final; a 503 or a network failure offers Retry.
3. The iframe loads that URL. `GET /ide/_handshake` is a static page with one hashed inline script that
   reads the fragment, clears it, and POSTs it. `POST /ide/_handshake` takes the grant with `GETDEL`
   (single use), re-checks the user as `requireAuth` does and the target's ownership, and sets the editor
   session: a JWT signed with a key derived from the JWT secret (the HMAC-SHA256 of
   `haive-editor-session-v1` under that secret, so neither verifier accepts the other's token), bound to the target, its
   runtime session and the editor origin, valid 8 h, in cookie `haive_editor_<task|repo>_<id>` with
   `Path=/ide/<target>/`, HttpOnly, host-only; `Secure; SameSite=None; Partitioned` on https,
   `SameSite=Lax` on http. It then redirects to `/ide/<target>/`.
4. Every `/ide` route except the two `_handshake` routes sits behind one router-level gate that accepts only
   that cookie for exactly that target and runtime; the app session opens nothing there. A bare
   `/ide/<target>` is redirected (308) to the slash form before any credential is read, since the cookie's
   Path does not cover it. The WebSocket uses the same session (`authenticateEditorUpgrade`,
   `lib/editor-auth.ts`) and the revocation fence the other sockets use.

Over plain http the Lax cookie survives only when the editor and the app are one site (scheme plus
registrable domain, ports ignored): the default `localhost:3000` and `:3001` are, while `app.localhost` and
`api.localhost`, two single-label hosts, or an http editor under an https app are not. There the tab shows
an operator message instead of a broken frame; serve the editor over https or under the app's registrable
domain. The site check (`lib/editor-origin.ts`, `tldts`) loads only for an http grant whose hostname or
scheme differs from the page's.

The app side is closed in three layers. The api trusts the editor origin as an `Origin` only under `/ide`
(`trustedOrigins`). `editorIsolation` (`middleware/editor-isolation.ts`) refuses a request off `/ide` that
carries `Sec-Fetch-Site: same-origin`, which is how the editor's own fetches to the api look when the app is
not served from the api origin. And the editor holds only its own cookie. Residuals: a browser without Fetch
Metadata can still make same-origin reads of the api from the editor in the default single-host install,
and an install that serves the app from the api origin needs a dedicated editor hostname for isolation (the
api warns at boot). All editors share one editor origin, so script in one editor can request another
runtime's `/ide/<target>/` while the browser holds that runtime's cookie (8 h); a per-runtime hostname
would close it. An open editor WebSocket is not closed when its 8 h session expires, only on revocation, as
with the app's sockets.

**The editor proxy never forwards the Haive session.** code-server runs `--auth none` and executes
repository code, so `routes/ide.ts` removes `haive_access`, `haive_refresh` and every `haive_editor_*` cookie
(every occurrence, by trimmed name, `withoutSessionCookies` in `auth/cookies.ts`), `Authorization` and `Proxy-Authorization` from the
HTTP request and from the WebSocket replay before anything is forwarded; a Cookie header left with no pairs is
dropped. The filter cuts the header into `;` groups by the quote rules, drops a group that still holds a `;`
inside quotes, and forwards every other non-session pair byte for byte, so a quoted value cannot smuggle or hide
a session pair. The request also loses its hop-by-hop headers (`connection` and every name it nominates,
`keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade` off the upgrade path, `proxy-*`), `expect`, and
the client's `forwarded` and `x-forwarded-*`; names are matched against the request's own header list, so a
malformed `Connection` token is ignored rather than thrown, and the WebSocket connect handler tears down only
its own session on any error. The replay head is written as latin1 so non-ASCII header bytes arrive unchanged.
code-server's port proxy is off twice: the api answers 403 to `/proxy/<port>` and `/absproxy/<port>` (first
segment, any case, of the raw remainder or its dot-segment-normalised form, since the socket bridge
forwards the raw path) on both transports before anything reaches the container, and editors launch with
`--disable-proxy`; one started before that flag is replaced once idle, by the editor lifecycle rule above.
`IDE_ENABLED=false` refuses the HTTP proxy as it does the ensure. The response direction drops the
same hop-by-hop headers and an upstream `Set-Cookie` for `haive_access`, `haive_refresh` or a
`haive_editor_*` cookie (`isSessionSetCookie`), on HTTP responses and on the WebSocket upgrade response head, so the container cannot
plant or clear the session; its other cookies, `forwarded` and `x-forwarded-*` still reach the browser. This
removes the credentials from the container's reach; the editor's own authority is the scoped session above.

## In-stack model access

An Ollama-backed CLI joins the internal `haive-models` network, where `ollama` and
`${HAIVE_INSTALL_ID:-haive}-ollama` resolve to `ollama-gate:11434`, not the daemon.
The daemon is only on `haive-network`; the api and worker retain direct access there
for embeddings, model listing and policy-controlled provisioning. The gate dials the
daemon by the daemon's alias `ollama-daemon`, never `ollama`: on `haive-models` that name
is the gate itself, so a dual-homed gate dialling `ollama` would depend on which of its
networks Docker's resolver answers from (on the version measured it was the daemon's). The gate joins both
networks and streams requests and responses without buffering, including SSE.

The gate permits `POST` inference at `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/api/chat`, `/api/generate`,
`/api/embed` and `/api/embeddings`, plus read-only `POST /api/show`. `GET` and `HEAD`
are permitted only for `/`, `/api/version`, `/api/tags`, `/api/ps`, `/api/hello`,
`/v1/models` and `/v1/models/<name>` (one literal segment). The measured Claude Code
2.1.323 traffic was `POST /v1/messages?beta=true` and `HEAD /api/hello`.

Everything else receives 403 before the upstream is contacted: pull, push, create,
delete, copy, blobs and future endpoints stay unavailable to sandboxed code. Matching
uses the exact method and raw pathname, without decoding or normalization; queries
are forwarded unchanged. Traversal, encoded path, trailing-slash and case variants
are refused, and method-override headers are removed. This closes direct mutation of
shared models by sandboxed agents while keeping provider URLs unchanged.

On the dev stack, a published port bypasses all of this. A sandbox under the `full` policy
(every provider's default) is on Docker's default bridge and reaches any published port: through the
bridge gateway when it binds all interfaces, and on Docker Desktop through `host.docker.internal`
even when it binds 127.0.0.1 (MEASURED, Docker Desktop 29.9.2: a 127.0.0.1-bound port refused
`172.17.0.1` and answered `host.docker.internal`). `docker-compose.dev.yml` therefore publishes
no Redis, Ollama or Mailpit SMTP port, and only Postgres and the Mailpit UI on the loopback, for
host tools. Both require credentials the sandbox does not hold: `scripts/dev.sh` generates
per-install Postgres and Mailpit UI passwords in `.env`, replaces the former public database
password on existing volumes through the local socket, and reconciles credential consumers
before completing a start. Mailpit UI/API login is `haive` with `MAILPIT_UI_PASSWORD`; SMTP
remains internal and unauthenticated. A failed database password sync stops dependants and
is retried on the next start. See README's source-build setup for host database client
settings and the credential-only rollback (the reverted script has no automatic sync).

Only installs whose compose bundle carries the gate have it. A release manifest with `bundle`
now makes `haive upgrade` verify and replace the compose files as well as the images, preserving
the installed GPU or Vulkan overlay. Fresh installers verify the fetched files and write
`.haive-bundle.json`; older installs without a record are recognised through the target's known
hashes. A modified or unknown bundle refuses until the operator accepts
`--replace-modified-bundle`, which backs up the old files before replacement. A target without
`bundle` still upgrades images only, so it cannot add the gate. The host helper and updater need
Docker Compose 2.24 or later. Required keys generated in `.env` stay after rollback so it cannot
reopen missing auth. See [Cutting a release](release.md) for verification, backups and recovery.

KNOWN SECURITY GAP, accepted for local single-user use (owner decision 2026-11-13): per-task ports
the worker publishes are reachable from other tasks' sandboxes. They bind 127.0.0.1, which
`host.docker.internal` reaches on Docker Desktop (MEASURED: ephemeral `127.0.0.1::port` and fixed
`127.0.0.1:port:port` both answered another container). Each is opt-in per task:

- The DDEV database port is reserved on every runner while the global `config:sandbox:dbDirectAccess`
  switch is on (default), but its socat hop listens only when a task also sets `exposeDbPort`
  (`maybeExposeDdevDbPort`). The hop accepts DDEV's fixed `db`/`db` login (`ddevDbAccess`), so
  any `full`-policy sandbox, another task's included, can then read and write that task's
  database. Turning the global switch off prevents new exposure; runners already exposed must
  also be stopped or recreated to close their database hops.
- The DDEV router, app and Mailpit ports are published only in the per-task external access mode
  with `BROWSER_DIRECT_ACCESS`, and nothing authenticates in front of them.

This MUST be closed before Haive is reachable over the web or shared by several users. Options
recorded then:

- a per-exposure random database role, which also requires refusing `db`/`db` through the hop
  without breaking DDEV's own app connection (unproven);
- an auth layer in front of the router and app ports;
- the root fix: stop sandboxes from reaching the host gateway at all, which on Docker Desktop needs
  egress filtering rather than a DNS override, since the gateway address stays reachable directly.

## Container attachment startup

The container WebSocket routes (`api/src/routes/terminal.ts` and `cli-login-banner.ts`) own
an acquired Docker attach stream through startup. They install its error listener before
asynchronous setup and close the stream through one cleanup path if that setup fails.
Terminal output listeners follow the count/session setup so buffered output still follows the
connected frame. The login banner finishes EOF token capture before deciding whether an active
probe defers cleanup.

The login banner sends the sign-in link only once `extractWrappedUrl` (`@haive/shared`) sees the
URL end: more text after it on its line, a blank line, or a line of prose, since a hard-wrapped
URL continues on whitespace-free lines. Output arrives in chunks that can stop anywhere inside the
URL, and a head sent as the link is never corrected. A URL still open gets `AUTH_URL_SETTLE_MS`
(1 s), counted once from its first sight, after which the end of the output is taken as its end;
the stream's end sends it first, ahead of the EOF token capture and the `exit` frame. Nothing is
sent once the sign-in has succeeded (`authSuccessSent`), because the modal resets its phase on an
`auth-url` frame. For codex, whose device code follows the URL after a blank line, the frame also waits
for the code to end (`extractDeviceCode`, the same terminator rule), within the same deadline; at
the deadline or the stream's end the end of the output is taken as the end of the code too. grok
and amp device carry the code in the URL and send at once. `stripAnsi` strips a charset designation
(`ESC ( B`, what ncurses' `sgr0` emits) whole, and `INCOMPLETE_ANSI_ESCAPE` holds a cut one back, so
neither a URL nor a captured token gains a stray `B`. `cleanupSession` clears every timer the session
armed, the two antigravity PTY resize timers and the 150 ms Enter after a token paste
(`oneShotTimers`) included, and a chunk that arrives after cleanup starts no antigravity URL step or
menu-advance timer.

The terminal route increments `containers.attached_ws_count` only after acquiring the stream,
and cleanup decrements only when that increment completed. Both updates are atomic
`greatest(attached_ws_count + delta, 0)` operations; a failed increment must not decrement
another attachment, and repeated cleanup must not release twice. This persisted count has no
operational reader and is not reconciled after an API process crash, so it does not prove that
a socket is still connected. Its longer-term purpose and the dormant worker count helpers are
tracked separately in T436.

## A step's project commands run in the sandbox

`08-phase-5-verify` and `08b-test-management` do not start a project's tests, lint or typecheck in the
worker process, which runs as root over the repository. `runStepCommandInSandbox`
(`sandbox/step-command.ts`) runs the argv in the task's sandbox image instead (the image and network
policy of `ctx.cliProviderId`: the task's own CLI, else the default provider, see
[Step summaries](step-summaries.md)), with the worktree
mounted at `SANDBOX_WORKDIR` (read-write; read-only only for a local-path repository with no worktree),
the git-data boundary and the secret masks. No auth volume and no provider env are passed: the
project's own code runs there and has no use for the CLI's credentials. `cwdRel` is relative to the
worktree root and must not leave it. The run holds an agent lease for its length (see
[Runtime and agent capacity](runtime-capacity.md)).

A command is reported as **not run**, never as a failing check, when there is no CLI provider to take
the image from (the task names none and the user has no enabled provider), the provider row is gone, no agent slot frees in time, or the binary is not on the image's
PATH. The last is read from a Haive-owned exit status (`BINARY_MISSING_EXIT`, 199) of a preamble that
checks `command -v`, so a project's own exit 127 stays the project's. A path the command writes
back to the worktree is read by the worker from the worktree afterwards: the phpcs report goes under
`.haive/verify` at the sandbox path, in a directory made writable for the sandbox user first. A DDEV
project's checks still run in the DDEV runner (`kind: 'ddev'`).

When the task's app runs in an app-runner container, the URL Haive records is
`http://localhost:<port>`, and inside a sandbox `localhost` is the sandbox. So both a step command
and an agent run start a node forwarder (`sandbox/loopback-forward.ts`) ahead of the command,
listening on `127.0.0.1` AND `::1` at that port and relaying to the runner by name. It must bind both,
because `localhost` resolves to `::1` first, and an IPv4-only forwarder failed `curl -6` (MEASURED).
It starts only when the app-runner reach probe succeeded (`loopbackForward` on the reach result).
DDEV projects already reach their `*.ddev.site` name through `--add-host`. Node rather than socat or
iptables: node is on every sandbox image, the others on none, and iptables would need a capability
the sandbox does not have. With no node the command still runs and one line says so. The trade-off:
a command that starts its own server on the app's port gets `EADDRINUSE`. Playwright's
`reuseExistingServer` reuses the forwarded app instead. No base-URL env var is set, since one could
override a value a project chose on purpose.

**Interpreter facts are advisory and belong to an immutable image.** For PHP projects, dispatch
peeks at each enabled provider's effective image (composed task image, provider image, then base
fallback) without ensuring or building anything. The peek and build share the composition calculation.
Peeks are memoized per task/provider configuration for ten seconds in a bounded cache, and one batch
inspects the core image once. The global KB and advisory lookup share a dispatch's task facets;
house-rule selection still reads fresh facets on every dispatch.

A shared promise cache keys `php` probes by inspected image ID, never by tag: `command -v` returning
Haive's reserved missing-tool status proves absence; shell/Docker failures and timeouts prove nothing.
A found PHP reports its version only when the output is a bounded version string. Unknown results
remain unknown in the cache for 60 seconds, with one pino warning per attempt containing only the
image ID, exit code and timeout flag. At most two probes run concurrently and the cache holds at most
128 entries. The dispatch batch waits at most 2.5 seconds. There is no global peek admission cap.

The probe runs as `node` with the image's PATH, no mounts or provider environment, no network, a
read-only filesystem, `--pull never`, `--cap-drop ALL` and `no-new-privileges`. With resource limits
enabled it has 64 MiB / 0.25 CPU / 16 PID caps; disabling the sandbox resource governor omits these
cgroup flags. Captured stdout and stderr share a 1 KiB limit; exceeding it removes the probe and
leaves the fact unknown. The host run timeout is 1.5 seconds and Docker cleanup awaits removal of
the named container. Inside the container, `timeout` or a shell watchdog kills a blocking probe after
one second even if the worker dies. The fallback kills the probe child and lets the waiting PID 1 shell exit. Boot and shutdown reaping include this install's labelled probes
in every Docker state, including Created and Exited.

Provider wrappers or PATH/shell-startup overrides omit the fact. A short per-provider prompt block
reaches ordinary prompts; an unknown fact adds no bytes. Queue stamps carry only the advisory block,
immutable image ID and its zero-based Unicode character offset in the stored prompt. An argv-size
fallback drops it before house and provider rules. If a leading block cannot be located, dispatch
rebuilds without the fact and never emits a blockless stamp. Execution inspects the chosen image
again and pins the launch to its immutable ID. A changed or unreadable image, or an environment
override introduced at execution, removes the owned advisory and its trailing blank line at the
stamped character offset. JSON user-message inputs are decoded before checking that position.
Full advisory quotes in agent rules, house rules and task text remain intact. The same rule applies
to Codex app-server turns and their exec fallback. Execution verifies the separator at that offset;
a mismatched positional payload is refused before any audit write or CLI send, without stripping
a different copy; the invocation fails once, and a Retry dispatches again with a freshly measured
stamp. Before execution, the stored invocation prompt loses the separator only
when the text at the stamped offset still equals it; a redelivery with the same stamp then changes
nothing. A failed audit update prevents sending the changed prompt. Older stamps without offsets
retain their first-match or counted-ordinal removal and audit behavior, and older full-prompt stamps remain readable.

Native and sequential sub-agent inputs have no production builder today. Their exec-time stamps
carry copy counts and, when needed, match ordinals to preserve quotes between independently adapted
prompts. Wiring these kinds requires deriving ordinals from the assembled text, since joins can
complete quoted separators, and a separate audit rule for their stored invocation prompts.
Project-local tools and the project's runtime may differ from the image; these facts do not install
PHP or replace deterministic checks. The probe uses non-login `sh`, so PATH changes in login startup
files remain outside the observation.

## Provider eligibility for interactive shells

A task or repository shell uses the provider named in its WebSocket URL; it need not be the
task's configured CLI. The task page initially selects that CLI only when enabled, otherwise
the server's enabled default, and offers enabled providers only. Opening a shell checks
provider ownership before eligibility. A disabled provider is refused with
`TERMINAL_CLOSE_CODES.PROVIDER_DISABLED` (4425), mapped by both terminal clients to
"The CLI provider is disabled. Enable it before opening a terminal." The worker also checks
the current provider before image resolution and before reusing or creating a container, so
a direct worker request cannot bypass the gate.

After a provider disable PATCH or DELETE commits, the api publishes an owner/provider-scoped
`close-provider` request on the existing `terminal:request` channel. The worker removes every
matching task and repository attachment from input routing and closes its PTY. It publishes a
`provider_disabled` exit reason through the existing output channel and retained exit key; the api
closes the WebSocket with 4425 and the same disabled-provider sentence, even when it subscribes
after the close. Other users and providers remain attached. Re-enabling publishes no open request;
a later connection reads eligibility again. Login containers use a separate lifecycle.

A disable that lands while a shell is still opening (its container ensure can build an image)
finds no session to close. The worker therefore reads the provider again once the session is
registered, after the container's reaper registry entry is written, so a refused container is
still removed by the idle reaper after the grace. It refuses the open if the provider is
disabled, and fails it if any close already removed the session; it never subscribes a removed
session's channels. Only the provider-disabled refusal carries `closeCode` 4425, so the api
closes that socket as it closes a live revocation; every other failed open closes with 1011.

This detaches the clients, preserving the normal two-minute tmux/container grace. A publication
failure is logged after commit and does not fail the PATCH or DELETE; existing sessions can then
remain open, while the connect gate still refuses new attachments to a disabled or deleted row.

## The task's current worktree

`tasks.worktree_branch` and `worktree_path` are written once, by 01-worktree-setup, and kept as an
audit record (the cancel and Finish reapers, the branch claims and the backfill script read them as
history). They are not where a task works now: a run_app Retry followed by a Skip of 01 leaves them
pointing at the abandoned worktree, and 12-worktree-cleanup or a cancel removes the directory without
touching them. Every reader that needs the current workspace asks one decision instead:
`decideTaskWorktree` (`@haive/shared`) reads the columns, falls back to 01's output for a task written
before the columns, and answers the repository root when the latest round of 01 is skipped. The worker
wraps it in `resolveTaskWorktree` (`repo/task-worktree.ts`), which checks the directory under the
repository's own root (`storagePath ?? localPath`) and refuses a removed worktree
(`WorktreeRemovedError`) rather than falling back to the root, since that would put a read-write agent
on the main checkout. The invocation mount, the Terminal, the prompt boundary and the api's file routes
(409) refuse; the runtime readers (`_task-meta`, `_spec-artifact`, `_external-drift`) use the decision
alone, because a runner teardown after 12 must not throw. An explicit `worktreeRel` (DAG issue, merge
fix) names its own tree and skips all of this.

The task Terminal attaches to one long-lived tmux session per container, and a tmux session keeps the
directory it was created in. So when the decision moves (a Retry then Skip of 01), a shell that was
already open still sits in the abandoned worktree. The worker reads the session's `session_path` at
every open, and again whenever the open page asks (`probe_workdir`, every 15 seconds while the tab is
visible; the answer travels on `terminal:workdir:<sid>`, apart from the PTY bytes). When the path
differs from the current decision, the page shows both paths and offers "Restart shell here". That
kills the tmux session (`restart_shell`), and every attached tab reconnects into a new session at the
current workspace. A restart and an attach are ordered by one per-container counter, so a shell that
attached after the kill is never told its later exit was the restart.

## Values in runner shell commands

`runnerExec` and `appRunnerExec` run their command through a shell, so every value spliced into one
goes through `shellQuote` (`sandbox/shell-quote.ts`), the one helper. That includes an app URL:
`ddevUrlFromConfigText` builds it from the raw `.ddev/config.yaml` before DDEV has read the file, and
ddev v1.25.2 writes a `project_tld` of `e'; id; '` into its config, refusing it only at a later
`ddev describe`. `probe-url-quoting.test.ts` pins the 12 `browser-probe-connect` command lines.

## What a sandbox shows the api

An agent's MCP servers reach the api with a bearer token the worker mints per task (`signTaskToken`,
`@haive/shared/task-token`): `v1.<payload>.<mac>`, the payload `{aud, taskId, exp}` with a 24-hour
expiry, and the MAC keyed per audience from `CONFIG_ENCRYPTION_KEY`, so a token verifies only for the
audience it names. `haive-rag` gets a `rag` token for `/rag/search` and `ddev-control` a `ddev` token
for `/ddev/*`; neither opens the other's routes, and neither takes the older audience-less two-part
token any more (its last ones expired a day after the change). Both refuse a body over 64 KiB with
413 before the token is read (`sandboxBodyLimit`), with a handler of its own so the 413 is a JSON
error naming the limit; Hono's default throws an `HTTPException` that `errorHandler` answers with its
own status, as plain text. The git credential helper's token (`signRepoGitCredToken`, `shared/src/git/token.ts`)
has the same `v1.<payload>.<mac>` shape, the payload `{repositoryId, userId, exp}` with a 12-hour
expiry and a MAC key derived for that one purpose, so no task token opens `/internal/git-credential`
and this token opens nothing else. The worker writes it into the repo shell as a file,
`~/.haive-git-credential-token` (mode 0600, replaced by a rename so a push never reads half of it),
not into the env, and writes a fresh one each time the shell is opened again and, from the terminal
reaper, once half its expiry has passed, so a shell kept open for days still pushes. The helper
reads only that file, and the route takes only this token: the env fallback and the older two-part
token keyed with the raw secret went once the last of them had expired.

RAG execution uses the existing signed step/invocation claims too. The worker puts
that bearer in `/haive/haive-rag.token`, one run-private read-only extra file beside
the MCP script, using the same delivery as custom and integration tokens. It keeps
the default 24-hour lifetime, including when sequential sub-steps each receive a full
timeout; server-side liveness checks bound attribution. All MCP configuration
delivery modes still carry only the shared task bearer in their env. The RAG proxy
prefers its own token file. A concurrent agent cannot replace that mounted file or
name an invocation for which it holds no token. The token file protects against
body-supplied ids and file replacement, not against a writer of shared task-volume
configuration, which picks the command the CLI launches in the other run's container
and so can read that run's token or change its env fallback. The token grants only
the task authority that writer already holds. A run without a step keeps a task-only token and logs unknown attribution.
Legacy env-only proxies remain query-compatible and unknown. On a 401 from the
file token, the proxy retries once with the env task token, preserving retrieval
with unknown attribution. A missing file uses the env token directly; other read
failures also emit one stderr diagnostic. No new token type, audience or tool
argument is used.

Captured Claude OAuth credentials are verified before promotion. The login API envelope-encrypts
its candidate with purpose, user and provider bindings before putting it on `cli-probe`; the
worker decrypts it for that probe only. It resolves no active provider secrets, mounts no shared
auth volume, removes competing legacy credentials from provider env, and overlays the candidate
`CLAUDE_CODE_OAUTH_TOKEN`. The configured executable/wrapper and ordinary provider settings still
apply. Candidate output is reduced to fixed diagnostics before returning through the queue, and
candidate probes never write active provider health.

Only an explicitly successful authenticated result can promote the candidate. The API checks
that the login socket is still open before promotion and across the transaction's awaited writes;
a close observed before the final check rolls back the credential, health and audit together.
Failure, an unknown/missing result, a thrown probe, session revocation or timeout preserves the
previous credential and profile. Successful promotion updates encrypted storage, legacy-env
cleanup, active auth health and its audit in one transaction, then requests the usage tick.

For a captured Claude token, wire `auth-success` is sent only after promotion commits, immediately
before `saved`. The browser uses that event as proof the credential is durable when recovering a
lost result through an ordinary active-token probe. Before promotion it stays in the pending
phase, shows queue progress, and offers a fresh login if the socket closes. The internal capture
guard still suppresses duplicate captures and `probePending` keeps stream EOF from ending the
session. Volume-based logins retain their existing earlier success event because their credential
is already stored.

## CLI sign-out and newer logins

A sign-out (POST `/cli-providers/:id/sign-out`) queues a job on the shared cli-exec queue that can
wait minutes, so a login completed in between must survive it. Two pieces do that:

- **Generation.** `cli_providers.auth_generation` (uuid) changes only when a user-driven credential
  write is durable: a volume login after the CLI's success signal (`runProbeAndSave`, after the
  `cli_provider.login` audit), the Claude OAuth save (`saveCliLoginSecret`, same transaction as the
  secret), a manual secret POST or a PATCH that moves a login secret, the usage reconnect, and the
  boot copy of secret-like env. A shared-volume login advances every row sharing that volume
  (`advanceVolumeLoginGeneration`, `@haive/shared/cli-auth-state`). An abandoned attempt, a usage
  refresh, a grok refresh and a task's sync-back never advance it. The sign-out job carries the
  value read at request time and, when the row's value differs, removes nothing and returns
  `{ ok: true, superseded: true }`; the poll route reports it as `done` and the page says the user
  signed in again. A job queued without the field (older release) deletes as before.
- **Lock.** Every credential writer and the sign-out job serialise on a session advisory lock keyed
  by the auth volume's name (`cliAuthScope`, path index 0, so shared and isolated rows resolve as a
  task mounts them). `tryCliAuthLock` (`@haive/database`) takes it with `pg_try_advisory_lock` on a
  dedicated one-connection postgres.js client (`fetch_types: false`, its own `shared` state), never
  a pooled connection or an open transaction; closing that client releases it, and the server
  releases it when the process dies. Nothing waits on it while holding a row lock. Each holder re-reads
  the row under the lock and refuses when its scope moved meanwhile (the job retries under the new scope,
  an api writer answers 409). A PATCH that changes `authMode` or `isolateAuth` holds the old and the new
  scope, sorted; a save that sends them unchanged takes no lock. A login dialog
  holds it from the WebSocket upgrade until its session is torn down (at most the 10-minute session
  timeout once the container exists). A login upgrade that finds it held, or finds the scope moved
  under it, or whose provider has no login, is accepted and closed at once with
  `CLI_LOGIN_CLOSE_CODES` (4409 busy, 4410 settings changed, 4411 login unsupported;
  `@haive/shared/constants`), since a browser cannot read a refused upgrade's status; the
  origin, auth and ownership checks still refuse before any accept, and the modal keys its sentence
  on the code. Api writers, and the deletes of a login secret (DELETE `usage-auth` and
  `secrets/:name`), answer 409 `cli_auth_busy` when it is held; a delete never advances the
  generation, so it cannot supersede a pending sign-out. The sign-out job defers itself (`deferJob`,
  2 s doubling to 15 s) and fails after `CLI_SIGN_OUT_AUTH_WAIT_MS` (30 minutes, counted from
  enqueue) with a sentence saying nothing was removed. That deadline covers only a job that never
  started: before its first removal the job records `signOutStarted` and the scope it removes
  (`signOutScope`), so a job redelivered after a worker death resumes its cleanup past the deadline,
  and stops with a sentence saying some credentials may be gone if the scope changed meanwhile; the page polls a sign-out for that cap plus
  2 minutes (other jobs 10), labels a wait by the job's structural wait reason (an auth-lock wait,
  or a pause/outage gate) rather than its message, and reads a finished job whose result has
  expired as finished with an unknown outcome. A scope that keeps moving under the sign-out fails it
  after five retries, saying nothing was removed, or, for a job that had already started removing,
  that some credentials may be gone. The login's own jobs never take the lock,
  since the api session already holds it: a volume probe publishes health only by compare-and-set
  on the generation, auth mode, isolation and the exact `auth_last_checked_at` it read, which a
  sign-out advances, so a probe that read before a sign-out cannot write over it; and a sign-out
  retries a volume still in use by a login helper (six attempts, 31 s of backoff). The usage poll takes the lock to refresh,
  re-reading the token under it, and again for every snapshot write, so a Disconnect between its
  fetch and its write leaves no stale snapshot. Each holder keeps the lock on its own connection, at
  most 32 per process (`MAX_CLI_AUTH_LOCK_CONNECTIONS`; beyond it a writer answers busy). A holder
  checks the lock is still its own (`assertHeld`, the backend pid it was taken on; a check unanswered within 5 s counts as lost) before a
  credential write; after a PostgreSQL restart or a terminated backend it stops, and a login
  session closes with "Authentication changed. Retry the login." A login holds the lock at most 2
  minutes before its container exists. Its teardown waits at most 30 s for `docker remove`, then
  releases the lock and stops waiting (the remove may still finish later). Every login attempt
  holds its own Redis lease (`cli-login-lease:<id>`, `@haive/shared/cli-login-lease`), written
  with a fresh token before the container is queued, renewed every 20 s with a 60 s TTL and
  compare-and-deleted when the lock is released. A renewal never recreates an expired key, and a
  failed renewal call ends the login only once the owner's own deadline passes, which comes no
  later than the key's expiry. The worker's login reaper (`sandbox/login-container-reaper.ts`, at
  boot and every 30 s) removes a login container whose lease is absent; when Redis cannot be read,
  or does not answer within 5 s, it removes nothing that pass. It never touches the auth lock, so a reaped scope starts a fresh
  login at once. A container from before the lease, found through its stored Docker id with no
  lease label, is kept for 13 minutes from its creation (2 minutes to start, a 10-minute session,
  30 s of teardown, and margin) and then reaped. Until the next pass a later login or sign-out
  may run beside an abandoned container. The provider secret migration's destructive drop phase also waits up
  to 30 s for it; its copy phase, which reruns at every worker boot, tries once and leaves a busy
  provider for the next boot. A task's sync-back waits up to 30 s for it; still held,
  it warns and the task copy is removed with its volume, so a token the task rotated is lost while
  a login dialog on the same CLI stays open that long (that login replaces it when it succeeds).

Undo: revert the change; the column is ignored by the older release
(`ALTER TABLE cli_providers DROP COLUMN IF EXISTS auth_generation` removes it).

## Version and package tokens in generated Dockerfiles

`isVersionToken` / `assertVersionToken` (`@haive/shared`, `tooling/version-token.ts`) own the
policy for pins and simple names interpolated into generated shell or Dockerfile text: 1–64
ASCII characters, a leading letter or digit, then letters, digits, `.`, `_`, `+` or `-`.
This permits dist-tags, prereleases and semver build metadata while excluding shell syntax,
Dockerfile line breaks, option prefixes, whitespace, NUL and Unicode. It checks the whole raw
value, including a final newline; it never trims or sanitizes one into another version.
This is token validation, not a promise that a registry publishes the version.

The environment dependency writer checks repository LSP/chrome-devtools pins before copying,
and typed runtime/browser pins before resolution. The generator checks both stored dependencies
and fresh render inputs, including runtime versions (Python's comment too), browser/DevTools
pins, extra package names, dependency language/manager names and the database-kind comment. FROM references keep their Docker
separators (`/`, `:`, `@`); each name/tag/digest component passes the token check. Safe runtime
version resolution (Go filename shaping, PHP's floor, numeric majors) remains after that check.
Package constraints or multiarch selectors are not simple package names; use the editable
Dockerfile for those. Empty/null pins retain their unpinned behavior.
Detected non-token runtime and database versions (from manifests, DDEV/Compose or the onboarding
mirror) are dropped before form defaults are built, so those fields offer their established
fallbacks; language/database detection is retained. Node constraints whose first dotted component
is numeric retain that major (`>=18.17.0 <21` and `^18.12.0 || ^20.0.0` become `18`), as the
previous Dockerfile renderer did; a generated DDEV config is then pinned to that major too. Simple manifest constraints that previously normalized to a token, such
as PHP `^8.1.10`, keep that behavior. Onboarding values are trimmed before token checking, and
blank values do not detect a language. Reused non-token runtime/database answers are blanked
before form validation so current defaults apply; valid prior choices remain. Apply checks database
versions, and the DDEV renderer checks them only when emitting a supported database service; the
Dockerfile guard does not check database versions because it never interpolates them. Other
unsafe submitted or stored operands still refuse. Refusals name the field and show a JSON-quoted
value truncated to 80 input characters. After JSON quoting, DEL/C1 controls and invisible/bidi
characters in U+007F–U+009F, U+200B–U+200F, U+2028–U+202E, U+2060–U+2069 and U+FEFF are escaped
as `\uXXXX`, keeping the preview safe to display.

The composed runtime-tools layer checks its RTK pin before building its URL or echo text. CLI
install codegen checks pins for npm, piggyback and curl installers; provider writes, clones and
cached-latest selection check them too. Registry, browser and Ruby catalogs drop unsafe version entries before caching, and an unsafe npm
or PyPI latest fails that source's refresh through its existing diagnostic path. Image callers
pass raw stored pins to codegen rather than trimming them first. The readable CLI tag segment
maps `+` to `_` because Docker tags cannot contain `+`; its content hash and install text keep
the original pin, so `1.0.0+build.5` and `1.0.0_build.5` remain distinct images. Shared-image
readiness logs and skips a provider whose stored configuration cannot resolve, without blocking
other matching providers in the transaction. A queued build of a refused pin records `failed` and
the escaped refusal under the provider row lock, only while name, CLI version and Dockerfile
extras still equal the refused configuration. Provider edits win. A locked refused configuration
wants no buildable tag; it is distinct from `null`, which means no image, so an older build
cannot write status or clear the previous image on behalf of a newly refused configuration. Chrome DevTools checks the pin
at the shared MCP surface (before cache warming) and at config rendering. Ollama provisioning
uses JSON fields and argv, not generated Dockerfile/shell interpolation of the model name.
Owner-authored Dockerfile extras and saved editable Dockerfile bodies remain free Dockerfile text.

A refused import keeps this install's setting and the old base and reports the setting through
the existing rejected-setting warning. A refused saved pin stops generation/image resolution
with a message pointing to Tooling, the CLI provider settings, or declared dependencies; correct
or clear that pin there; re-run dependency declaration before generation, or Retry the image build. No stored data is rewritten.
Undo: revert the code change. No schema or data rollback is needed. The output fixture in
`worker/test/fixtures/version-token-baseline.json` records origin/main's renderer bytes for
representative valid pins, so unchanged versions keep their Dockerfile bodies and image hashes.

## Optional composed LSP recipes

`ComposeInput.lspInstallContractVersion` selects the installation owner. Absent/1 ignores
`lspServers` and `lspServerVersions` and keeps the exact legacy Dockerfile body and tag. Contract 2
selects the composed recipes only for a catalogued Claude-binary provider with the existing LSP
bridge; other CLIs (including grok), unknown names and unknown contracts refuse by name even with
no selected servers. `lsp-layer.ts` canonicalizes language/server aliases, deduplicates and sorts selection, and
reconciles pins. For pinnable servers, raw values pass shared `assertVersionToken` without
trimming; empty/null means unpinned. Unsupported server keys throw explicitly. In the composer
normalizer, rust-analyzer/jdtls pins are ignored before validation and hashing, matching legacy
installation and the UI's non-pinnable choices; ignored text is never rendered. Existing API/import
pin-validation boundaries still apply before values reach the composer.

Go and Solargraph accept legacy's safe-token domain, including partial versions and tags; there
is no new exact-semver requirement or API restriction. Bare/v-prefixed Go releases canonicalize
once. Token validity is not proof that a registry publishes it: legacy 02 adds `v` to a nonempty
Go pin, and passes a gem pin directly. Those install-time resolution failures remain failures.
Selection metadata and recipe bytes enter the hash with provider, RTK, extras and core-image
identity. Contract 2 includes a constant installation-owner marker even for an empty selection;
legacy absence/1 adds no bytes and retains the old tag. The structural fixture freezes
both pre-feature assembly and `buildHaiveRuntimeToolsLayer`; shared RTK constants and provider
codegen stay live. Intentional runtime-tools edits must update that fixture too.

Node-based recipes install Intelephense, vtsls and Pyright with npm under `/usr/local` and check
the plugin executable name. Pyright uses npm's `pyright-langserver` instead of the legacy pip
wrapper, avoiding a second Node download at first use on this optional path. Missing/old
Node/npm is supplied through apk or NodeSource on apt, followed by Node >=20 and npm engine
checks. The composer uses fixed `setup_22.x`, as provider codegen does; environment step 02 uses
`setup_${nodeMajor}.x` from its resolved Node major. Other package managers fail explicitly.

Native recipes have these runtime contracts:

- **gopls:** compatible base Go >=1.21; `GOTOOLCHAIN=local` prevents implicit build-toolchain
  replacement and `GOBIN=/usr/local/bin` exposes the binary. The upstream support policy says
  current gopls runs with the two latest Go lines; that is an upstream-only claim, not measured
  compatibility of this composed image. Older Go may need an older gopls pin.
- **rust-analyzer:** isolated stable toolchain, analyzer and rust-src under `/opt/haive-lsp/rust`.
  The wrapper puts the real toolchain binaries on its own PATH and executes the analyzer directly.
  It exports none of CARGO_HOME, RUSTUP_HOME or RUSTUP_TOOLCHAIN: no rustup proxy is needed on
  this path, and Cargo retains its user's writable cache or a caller-supplied CARGO_HOME. Private
  homes are used only for installation/discovery. Project-wide compiler PATH is unchanged.
  Real Cargo metadata/dependency fetching and sysroot discovery remain a pre-cutover build gate.
- **Solargraph:** base Ruby >=3.0, RubyGems, matching development headers, make and a C compiler.
  The 3.0 floor follows 02's MEASURED Ruby 3.0.7 -> Solargraph 0.58.3 dependency backoff, not
  the upstream current gemspec's >=3.1 (an upstream-only current-package claim). Below 3.0 skips,
  as legacy does. Isolated gems under `/opt` and a public wrapper avoid root's gem directory.
  Safe pin tokens are passed to RubyGems. Solargraph has no supported CLI bridge here.
- **jdtls:** base Java >=25, Python >=3.9, curl and tar. Java resolution follows JAVA_HOME then
  PATH. The Java 25 README floor and Python launcher's Java 21 check are upstream-only facts,
  not successful image startup evidence. The recipe uses the stricter floor and a public wrapper
  over a readable snapshot under `/opt/haive-lsp/jdtls`. Pins are ignored, as in legacy.

Before native checks, the layer reuses provider codegen's idempotent ENSURE_NODE_USER_LINE;
02-generated Ubuntu bases need not already contain node. Each native launcher check runs as node
via su, with the image PATH passed as a positional argument and restored inside the child shell.
A composed-body stub control executes the RUNs in order and proves `id -u node` succeeds before
first su; another simulates su resetting PATH. This is shell-control evidence, not a real Ubuntu
image build. Native runtime checks verify Go/Ruby versions, the direct Rust analyzer, or jdtls
help; none proves LSP protocol activation.

Missing/incompatible native prerequisites emit `# <server> SKIPPED: <reason>` to the build log
and finish that recipe RUN without installation. This includes missing su, Go below 1.21, Ruby
below 3.0/missing headers and incompatible Java/Python. A skip is never installed evidence.
Before each skip-capable native recipe the layer removes its recipe-owned
`/usr/local/bin/<server>` launcher, and the probe opens that exact path, so an old
launcher inherited from the saved base cannot turn a skip into success. Other PATH candidates
cannot satisfy the probe. Once installation starts, registry
resolution/download/build and post-install launcher failures still fail the image; legacy's
unguarded go/gem/rustup/curl RUNs also fail in those cases. Node/npm supply still fails when its
shared provider/runtime requirement cannot be met. Such failures prevent a replacement task
image from being published; production wiring remains deferred.

Moving inputs include gopls `@latest`, unpinned npm packages (including TypeScript) and gem
resolution, Rust stable and the jdtls latest snapshot. The NodeSource script, rustup installer
script and jdtls tarball have no recipe-level checksum verification, as in legacy. RTK separately
verifies its release's checksums.txt. At one recipe hash, an uncached rebuild can therefore differ;
immutable version/toolchain resolution remains an activation decision. Unit/stub checks and
upstream documentation do not establish successful native downloads/builds or protocol behavior.

Primary upstream references (requirements/documentation only):
[gopls support](https://go.dev/gopls/#supported-go-versions),
[rust-analyzer installation](https://rust-analyzer.github.io/book/installation.html),
[Cargo home](https://doc.rust-lang.org/cargo/guide/cargo-home.html),
[Solargraph gemspec](https://github.com/castwide/solargraph/blob/master/solargraph.gemspec),
[jdtls README](https://github.com/eclipse-jdtls/eclipse.jdt.ls#requirements) and
[Python launcher](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/main/org.eclipse.jdt.ls.product/scripts/jdtls.py).

The shared cache calculation now reads the saved template's `declaredDeps` contract, selection
and pins. Ensure and read-only peek use that same calculation, saved body, referenced core ID,
provider/version/extras and repository RTK pin (or the existing RTK cache/default). A missing task,
link or template, or an ordinary non-ready/empty-body template, explicitly yields no composed
environment decision and keeps provider/base resolution. A linked row's contract/CLI is validated
before a non-ready or empty body can fall through. A missing requested composed image makes peek
answer unknown, never a provider fallback; peek never ensures/builds the core or composed image.

Composed ensure now holds the same per-tag lock used by provider builds/removals across inspect
and build; concurrent ensures reuse the first successful build. A failed build is not shared:
each queued caller then runs its own build in turn, so a failing step costs its duration once
per waiter (accepted while composed builds are rare; the provider path's in-flight join is the
model if it matters). The existing provider export and
lock semantics remain. Composed boot reaping takes that lock, compares the current immutable image
ID with its age snapshot, lists stopped as well as running containers, and removes without force,
so Docker refuses an image still used by any container. Legacy replacement builds still throw
without removing a previous cached image. Contract 2 now adds verification and task-owned
publication, described below.

## Composed LSP verification and retained images

Contract 2 has readers and verification, with no 01 contract writer and no 02 installer suppression.
Existing absent/1 rows retain their checks, reports, image composition and readiness rules.
Generation, including saved-body reuse, still refuses contract 2. No manifest bump or SQL migration
is included.

04 separates runtime/client checks (the inspected environment image) from selected LSP servers
(the exact inspected composed image ID). Its LSP runs use node, the image PATH without provider
or host overrides, no repository/auth mounts and no network. Each selected launcher must yield
installed/server and toolchain versions and a JSON-RPC initialize response with capabilities.
A launcher exit or command-v alone cannot pass. These are image/server checks; they do not claim
that a logged-in CLI has activated its plugin. Missing, skipped and omitted checks fail readiness.
No real image build or logged-in CLI acceptance was performed for this slice; native downloads,
real protocol compatibility and the moving-input release decisions above remain activation gates.

Legacy `output.reports` stays unchanged. Contract-2 `output.environmentReports` carries runtime
checks and `output.composedLsp` carries schemaVersion 1 and a complete provider-identified entries
array, rewritten per run without merging an earlier output. It records exact saved-body and recipe
hashes, template and contract, canonical selection/pins, current provider configuration identity,
01b result and PHP plugin-file hashes, composition hash/tag, immutable environment/composed IDs,
versions, bounded per-server reports and an explicit image-verification outcome. Only one provider
is verified per 04 run, with at most seven selected-server reports and 2,000 captured characters per
output stream. A later provider needs its own matching 04 evidence.

01b records provider configuration and local PHP plugin-file hashes only for contract 2. A
contract-2 apply refuses changed detect-time provider/selection inputs, and refuses provider or
file changes during installation. Missing/omitted plugin results, unbound older results, PATH or
shell overrides, wrappers, altered PHP files, partial reports and Ruby-only selections never
advertise a callable bridge. The recorded plugin language set must cover every currently
selected bridged server. Legacy dispatch evaluates readiness once, independent of provider
count; only contract 2 fans out per provider. Dispatch and execution compare the complete current
identity with 04 and the retained effective reference; execution uses the inspected
immutable image ID. Snapshot workspaces still exclude LSP. A task without a matching completed
04 row is unready.

**A verified launch stays pinned.** The reference records the resolved RTK version, the core
image ID and the repository's explicit RTK pin separately, plus a hash of the exact saved body,
canonical selection/pins and provider image settings. Launch and peek resolve against those
recorded inputs. An RTK cache refresh, a core rebuild or an ordinary recipe change cannot move
the launch to another tag or make it fail. A template rebuild with the same saved body also keeps
the pinned launch, while readiness still requires a ready template. A changed saved body,
selection/pins, explicit RTK pin or provider name/CLI version/Dockerfile extras refuses launch
until the requested replacement is
verified; it never silently uses the old image as those new inputs. The tag is still inspected
and must name the verified immutable ID. Readiness uses the recorded RTK/core inputs too, while
continuing to compare current recipes and the provider/plugin result with 04: a worker recipe
change may withdraw tools without changing the pinned launch image.

The provider configuration hash uses an explicit allow-list. Name, CLI version and Dockerfile
extras configure the installer/image; wrapper body, environment, CLI arguments and executable/
wrapper paths determine which plugin command runs; auth mode and isolation choose its plugin
storage namespace. Provider id/ownership/enabled are checked separately. Learned model limits,
provisioning status/errors, rules text, auth generation/health and timestamps do not change this
hash, since they change neither the image nor the plugin installation. The exported
allow-list and explicit ignore list must cover every provider schema column exactly once; a
coverage test fails when a new column has not been classified.

**Image ownership survives Retry.** Existing `tasks.metadata.composedLspImageRefs` is versioned,
provider-keyed and bounded to 16 provider entries, each with effective, prior and verifying refs.
The worker updates only that key from a freshly locked task row, preserving unrelated metadata.
It reserves the candidate before checking it and publishes only after every environment/server
check passes, in the build's existing per-tag turn. Step generation and task epoch fence Retry;
provider and environment row locks fence edits during the final identity comparison/publication.
A failed requested replacement keeps effective/prior references and reports failure, and is
never served as the old image under the requested pins. Pending verification ownership also
survives a crash. 04 output remains disposable readiness evidence: a reset clears it and therefore
readiness, while the task-owned references remain. A pending/reset 04 is read before completed
rows, including a completed higher round, so a Retry cannot reuse another round's old evidence.
The composed reaper reads live tasks' references, including prior/verifying IDs, before selection
and again in the tag turn. A refused ownership
read keeps images. Container checks and non-force Docker removal remain the final backstop.
Publication bounds retained history. Completed and cancelled tasks release durable reaper
protection; their metadata remains audit history. Failed tasks are revivable through Retry and
allowance auto-resume, so they continue protecting effective, prior and verifying references,
without an age bound, as do paused, queued, running and parked tasks. The status filter shares
`TERMINAL_TASK_STATUSES` with step ownership. Existing task shells, including stopped containers,
remain protected by the container check. The terminal launcher can read a reference after task
end, but that does not reserve an image forever: a cold shell opened after a completed or
cancelled task's age-based eviction fails closed if the retained image is gone. There is no
post-completion workflow consumer requiring indefinite image retention. The reaper uses a bound
`jsonb_exists` key test combined with the non-terminal-task status filter.

**Activation ordering remains open.** Ordinary workflows run 04 before 01b. An initial 04 therefore
records a missing plugin result and cannot make LSP ready, even after 01b later completes: that
completion changes the identity. Under this order a Retry of 04 cannot make contract 2 ready:
it resets downstream 01b again, which completes after 04 and changes the plugin identity again.
Retry 04 rebuilds and re-verifies the image so launches resume, but cannot restore LSP
readiness under the current order.
The writer slice must arrange a fresh 04 verification after the
plugin result, or another explicitly reviewed ordering, before enabling contract 2. Nothing here
writes a contract-2 template, strips saved installers or changes an onboarding artifact version.
Revert this consumer slice before the cache-contract slice while no writer exists. If a later
writer has enabled contract 2, stop those writes and restore retained legacy template links/images
before removing readers; never downgrade metadata on a body without its legacy installers.

## PHP database drivers in generated environments

For non-DDEV environments that install PHP, `02-generate-dockerfile` installs the
version-matched database extension beside `php<v>-cli`: `sqlite` selects
`php<v>-sqlite3`, `postgres` selects `php<v>-pgsql`, and `mysql` or `mariadb`
selects `php<v>-mysql`. These use the same normalized/floored PHP version and apt
source as the interpreter, including the Ubuntu ondrej PPA path.

`01-declare-deps` already reads root `composer.json.require`. That reader also
maps `ext-pdo_sqlite`/`ext-sqlite3`, `ext-pdo_pgsql`/`ext-pgsql`, and
`ext-pdo_mysql`/`ext-mysqli` to the three fixed package suffixes. It persists a
sorted, deduplicated `phpDatabaseExtensions` only for selected non-DDEV PHP
runtimes with such requirements. Requirements may add drivers beyond the declared
database. `require-dev` is outside this detector's scope. No extra manifest read
or general extension detector is added. DDEV still owns its PHP and database;
its Dockerfile and declared-dependency identity are unchanged.

Deployment does not rewrite saved Dockerfiles, mark existing PHP templates stale,
or force a rebuild. `envTemplateHash` hashes saved Dockerfile text plus canonical
declared deps, rather than generator source. Rendering the corrected Dockerfile
changes that hash, but a saved Dockerfile and matching prior-task form text remain
reusable when their declared deps match. Rebuilding an old saved body alone will
still build the old body. To update one, submit the corrected Dockerfile and
rebuild it. A new Composer-driver key discovered on dependency declaration takes
the existing changed-deps path: invalidate the old body/image, or fork the row
when other live tasks share it, then regenerate and build. There is no schema or
generator-version migration.

Onboarding has no environment-image build step. `01-env-detect` and
`02-detection-confirmation` discover/confirm the stack, while
`04-tooling-infrastructure` configures tooling. The built-in workflow includes
`01-declare-deps`, `02-generate-dockerfile`, `03-build-image`, and
`04-verify-environment` as its unfiltered environment prelude. Declaration and
Dockerfile review need form answers unless auto-continue can reuse a completed
task's answers (or explicit pre-answers exist); build and verify opt into default submission
under auto-continue and reuses an existing ready, present image unless forced.
Non-DDEV run-app tasks also use generation/build; DDEV run-app tasks instead use
`01c-ddev-env`. The composed sandbox reads the ready template's saved Dockerfile.

Undo: revert the code commit. No schema/data rollback is needed. Already-built
images keep their installed modules; remove the package from the editable body
and rebuild only if removing it is desired. The optional declared-deps key is
ignored by the older generator.
