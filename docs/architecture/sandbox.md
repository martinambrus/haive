# Sandbox

`packages/worker/src/sandbox/clawker-client.ts` wraps the clawker binary. The worker container mounts `/var/run/docker.sock` and uses Docker-in-Docker to spawn per-task containers. Only the cloned repository is bind-mounted into the per-task container. The worker filesystem and the user home directory are never exposed. CLI authentication files are copied into a named volume per task at startup and the volume is destroyed at task end. At worker boot `reapOrphanedAuthVolumes` removes a task's copy whose task ended, and an isolated provider's or a user's auth volumes once that row is gone, so a deleted provider or user leaves no CLI credential on the host. A login session still holding such a volume is removed with it, since its row went with the owner's and nothing else would. The owner is read back from the volume's name (`cliAuthVolumeOwner`, beside the builders).

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
