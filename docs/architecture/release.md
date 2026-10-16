# Cutting a release

The release event is a TAG, never a merge to main. Main takes dozens of commits a day and stays
CI-gated but publishes nothing; `git tag v0.2.0 && git push --tags` is the whole release, and
`.github/workflows/release.yml` does the rest. **The tag IS the version** — nothing in the tree
carries a release number (`APP_VERSION` is the dev sentinel `0.0.0-dev`), so there is no
version-bump commit and no drift across package.json files.

The workflow builds api/worker/web for amd64 and arm64 on NATIVE runners (the repo is public, so
GitHub's arm64 runners are free; macOS is a first-class RUN-IT target and QEMU would cost tens of
minutes), pushes them to `ghcr.io/<owner>/haive-*` by digest, joins each into a manifest list
tagged with the version plus `latest` — or `next` for a `-rc` tag — and attaches a `release.json`
to the GitHub Release. `haive upgrade` reads that manifest: it carries the image digests, the
`migrationHead`, and `contracts` (whether this release removes anything, which decides if a
rollback can simply re-pin the previous tag).

Pass `--min-from` to `scripts/build-release-manifest.mjs` only to declare a REQUIRED STOP ("you must
pass through v0.3 first"). It defaults permissive on purpose: a floor equal to the release blocks
every upgrade to it.

To run a published release instead of building from source:

```bash
HAIVE_VERSION=0.2.0 docker compose -f docker-compose.yml -f docker-compose.run.yml up -d
```

That overlay swaps `build:` for `image:` (via `!reset`, because compose MERGES and would otherwise
still build) and adds the `db-migrate` one-shot that `docker-compose.yml` lacks — the dev stack gets
it from the dev override, so a published-image install would otherwise boot against an unmigrated
database. `HAIVE_VERSION` has no default so the command fails rather than silently resolving
`latest`; which version an install runs is the question every upgrade and rollback turns on.

## The drain an upgrade runs first

`haive upgrade` (the updater) sets `MAINTENANCE_STATE` to `draining`, waits until no task is live,
then sets `maintenance` and takes the snapshot. Every api route that starts work refuses with 503
while the state is `draining` or `maintenance`. Its authority is `admitNewWork`: a read of the state
past ConfigService's 30 s cache inside the transaction that records the work, under a shared
database fence (`lockNewWorkFenceShared`, an advisory lock on `NEW_WORK_FENCE_KEY`); most routes
also answer an early 503 from the same fresh read before they start (`assertNewWorkAllowed`). Every
updater state write (`draining`, `maintenance`, and the return to `normal` on commit or rollback),
like an administrator's maintenance write, takes the same fence exclusively (`setMaintenanceState`):
it waits for every admission in flight, so the live-task count it reads next includes each task
admitted before it, every admission after it reads the new state, and no write lands inside an
administrator's write. Lifting the hold therefore needs Postgres: an updater that cannot reach it
leaves its run `running`, and the next `haive upgrade` resumes into the commit or the rollback. The gate that
locks non-admins out during `maintenance` keeps its cached read, so that lockout can lag by up to
30 s. In the worker, the allowance auto-resume and an answer to a parked form do not reopen a
failed task while new work is refused (see [Worker restarts](worker-restarts.md)).
