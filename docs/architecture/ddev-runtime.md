# DDEV runtime

**Stop and Retry abort a cold DDEV startup, including its debug/database wiring.**
The step's abort signal used to reach only runtime admission. Task `987e2eb2` stopped
`01c-ddev-env`, retried `98-choose-view` from VNC to direct access, and spent five minutes
with a pending step while the superseded startup still built images. `withDdevBootCancellation`
owns the immutable container ID returned by `docker run` until bring-up and wiring finish.
Aborting removes that runner and its anonymous Docker volume; killing the host's `docker exec`
client alone cannot stop the nested process. Creation that finishes after the abort is removed
too. `DdevBoots` keeps the old boot held until teardown settles, then a surviving caller boots
with the current settings. Every coalesced caller's signal reaches the shared boot, including
a step that joins a signal-less runtime-ensure job. The shared signal also cancels runner-image
inspection/build and stale-image pruning before a container exists. A completed runtime is
no longer owned by that startup, so an
ordinary Stop keeps its imported database as before.

**A changed browser choice must reconcile the runner's immutable published ports.**
An existing VNC runner cannot gain direct browser ports by changing `tasks.direct_access`.
Every DDEV ensure compares that choice (including the global switch) with the published-port
labels. A mismatch first snapshots the live database, then replaces the runner.
Access snapshots alternate between `haive-access-<task>-0` and `-1`: clean the inactive
slot before creation, retain the latest backup until the replacement runner has restored
the new snapshot successfully, then prune
the superseded backup. Legacy timestamped access snapshots are pruned too. Repeated mode
changes retain one backup, with at most two during replacement, rather than multiplying
the database on the shared repository volume. Port inspection failures fail reconciliation; they never
mean that direct ports were absent. Projects whose effective merged DDEV configuration
explicitly omits the DB container (including SQLite projects) can recreate without a DB
snapshot; an unreachable or empty configured database cannot waive preservation.
Snapshot failure leaves the existing runner intact. Cold recovery
restores that access snapshot and refuses a failed restore rather than serving an empty database.
Failed bring-up removes the newly created runner before releasing the boot, so Retry must
attempt the cold restore again instead of reusing a serving runner with an empty database.
A later import or migration snapshot takes precedence by modification time, retaining the
winning name even when both ordinary snapshots exist. A known snapshot that fails to restore
does not fall back to an older database. Subsequent cold recovery cannot undo database work
done after the access change or a later re-import. Snapshot paths use the same
anchored filesystem primitives as other DDEV inputs. Snapshot listings iterate the held
directory with a 1,024-entry cap and stat candidates sequentially. Exceeding the cap fails
recovery instead of choosing from a partial listing or allocating work for every entry.

**A worker reload cannot rely on its in-memory boot map to serialize DDEV.** On task
`70b9dc50`, repeated source reloads re-drove `01c` while the old `docker exec`'s
`ddev start` still ran inside the surviving runner. Two compose operations then collided
on `ddev-elmont-novy-codex-web`, and warm recovery discarded the runner's image cache.
Both buffered and streaming `start`/`restart` and snapshot/restore/cleanup commands hold the same runner-local
`flock` outside the repository. The lock survives loss of the worker/client and is
released when the nested command exits. Lock acquisition allows 900 seconds for an
orphaned cold boot, then a runner-local `timeout` gives the new command its full execution
budget (300 seconds for warm startup, 900 for cold startup/restart), plus ten seconds
before KILL. The host exec timeout includes both budgets and that grace, so a late lock
acquisition cannot launch a command with only seconds remaining before its client dies.
A warm recovery whose lock wait expires fails without rebuilding or deleting the existing
runner: the earlier operation may still be restoring its live database. Snapshot locking
also prevents a re-driven access change from reusing a slot while an orphaned snapshot writes it.
Selection, stale cleanup, creation and promotion run in one non-root runner process under
that lock. A provisional `haive-access-pending-<task>` snapshot is promoted to the selected
slot only after creation succeeds; interrupted partial copies never count as recovery points.
The replacement restores that exact committed slot, without re-selecting by file times.

**An HTTP 4xx from the mandatory runtime smoke is UNSURE, not PASS.** The unauthenticated
probe cannot distinguish a login/access wall from a broken route. `08-phase-5-verify`
records `runtimeSmoke.passed: null` for a 4xx without a runtime-error signature; an explicit
fatal/DB error still records `false`, as do 5xx and no-response failures. Gate 2 renders an
amber UNSURE row with the HTTP code and response excerpt, and does not pre-select Approve
unless a completed, verified MCP/interactive browser test passed. Manual, skipped or
incomplete browser results cannot override it. Runtime smoke never drives an automatic fix
round. `runtimeSmokeVerdict` also reclassifies legacy 4xx `passed:true` payloads at form
render time, so a gate already parked with a saved 403 pass shows the warning without
re-running detect. Migration `0174` repairs the rendered forms already stored on
unsubmitted, genuinely waiting gates, preserving their evidence and all human decisions.

**An import that exits 0 is not an import that happened.** `ddev import-db` returns 0 for a dump that created nothing — wrong engine, truncated stream, an archive whose restore wrote no statements — so `01c-ddev-env` counts the tables afterwards (`ddevCountTables`, via `ddev psql` / `ddev mysql` so DDEV owns the credentials). MEASURED on task ef954a3d: the step recorded `"imported": true, "DDEV started; database dump imported"` against a database with ZERO tables; every request answered `relation "semaphore" does not exist`, and the run only found out ~20 hours and 5 fix rounds later at gate 2, where no code change could repair it because the failure was never in the code. Only a CONFIDENT zero blocks — a probe that could not be read returns null and warns, since refusing an import on a probe that failed to run would block projects whose database is fine.

**`06a-db-migrate` detects a framework by files it SHIPS, not by composer.json.** A `drupal/core` regex reports `unknown` for every Drupal 7 site (7.90 ships no composer.json at all), which left `migrationCommand` empty, silently skipped `drush updatedb`, and — because the D7 bootstrap pre-flight below it is gated on `framework === 'drupal'` — made the check that exists to catch an unusable database dead code on exactly the sites it was written for. Markers must be TRACKED files: the workspace is a git worktree, which materialises tracked files only, so `wp-config.php` (credentials + salts, universally gitignored) is the wrong way to find WordPress and `wp-includes/version.php` is the right one — the same failure class as a test fixture missing from a worktree. Root `includes/bootstrap.inc` is D7-only (D8+ puts it under `core/`) so it is checked first; both resolve to `drupal` because the command and the pre-flight are identical.

**A `ddev restart` RECREATES the web container, so nothing installed inside it survives one.**
Only `/mnt/ddev-global-cache` (a named volume) and the bind-mounted project outlive it;
`/home/ddev/.cache` is in the container's writable layer and is not a symlink into that cache.
That made two things wrong at once. `07c-ddev-reconcile` compared the on-disk `.ddev/` hash
against a baseline read from `01c-ddev-env`'s ROUND-0 output that nothing ever rewrote, so once
the implementation touched anything under `.ddev/` the hashes differed permanently and every
later fix round restarted DDEV again — MEASURED on task 681f0f99, rounds 1/2/3 all
`action: restart` with php unchanged 8.3 -> 8.3. A successful restart/migrate now stamps
`appliedBaseline` (the state it applied) and later rounds diff against that; the field is
OPTIONAL, so a payload written before it existed falls back to the boot baseline and behaves
exactly as it did. `loadAppliedBaseline` deliberately does not use `loadPreviousStepOutput`:
that returns the highest-round row, which during this step's own run is THIS row with a null
output, so the prior round's answer would never be seen — filtering on a written output also
makes a retry correct for free, since the reset nulls that column.

**Playwright's runtime is provisioned per task, and the two halves have different lifetimes.**
The DDEV web image ships neither the browser binaries nor the libraries they link against —
MEASURED on `ddev/ddev-webserver`: `ms-playwright` absent and 13 of the 15 libraries chromium
needs missing — and nothing in the sandbox can add them, since the CLI is given
`ddev_status`/`logs`/`restart` and no `ddev exec`. `ensureDdevPlaywrightBrowsers`
(`sandbox/ddev-playwright.ts`, called from 08b before a ddev playwright run, idempotent) puts
the BINARIES on the `ddev-global-cache` volume behind a symlink at the path Playwright already
looks in — so no `PLAYWRIGHT_BROWSERS_PATH` has to be threaded through the run command and a
human running `ddev exec npx playwright test` gets the same browsers — while the apt packages,
which cannot leave the container layer, are re-installed per container behind a `/tmp` marker,
the lifetime that matches. MEASURED: ~70s to re-provision after a restart, with no re-download.

`playwright install-deps` CANNOT be used, and that is measured rather than assumed: on Debian
trixie Playwright falls back to its ubuntu20.04 package set and asks apt for
`ttf-ubuntu-font-family`, which Debian does not have, and one unavailable name aborts the whole
`apt-get install` — so the command exits 0 having installed NOTHING. The package list therefore
comes from Playwright itself (`install-deps --dry-run`) and each name is filtered by `apt-get
install -s`, the authoritative resolver. That filter is load-bearing, not defensive:
`libasound2`, `libatk1.0-0` and `libfontconfig` are all `Candidate: (none)` in trixie and all
three are libraries chromium needs, so filtering on `apt-cache policy` instead would have
silently dropped three real dependencies and produced the broken browser this exists to
prevent; the simulator resolves them through their t64 providers and rejects only the package
Debian genuinely lacks. Reading that list is the one volatile dependency, so it FAILS LOUD with
its own exit code rather than installing an empty set and marking the container done. The
script ships base64-encoded because `ddevExec` interpolates its argument into a `bash -lc`
running in the RUNNER, where `$HOME` and `$(…)` would evaluate against the wrong container.
Chromium only — `playwright install` cannot be told what a config needs, and naming no browser
downloads all three — so a suite driving firefox or webkit reports the gap through 08b's
`degradedNote` instead. `CONFIG_KEYS.TEST_BROWSER_PROVISION_ENABLED` is the kill-switch.

The DDEV project's Mailpit is surfaced at every step that already shows the running app (08a, Gate 2, `99-run-app-ready`), and the URL is always what `ddev describe -j` REPORTS (`parseDdevMailpitUrls`), never one we compose. That is what makes a single string right in both viewing modes: the headed browser runs INSIDE the runner and dials the same `*.ddev.site` name the host does, so the VNC half needs nothing published — MEASURED, `curl http://<project>.ddev.site:8025` from inside a runner answers 200. The host half publishes slots 3/4 at runner create (the DB-port argument: `01c` boots before the browser choice is known) and pins `ddev config global --mailpit-{http,https}-port` to the same numbers, in the exec that already sets `--router-*-port`; global config is per-runner, so no repo file is touched and nothing lands in review scope. NOTHING gets a `localhost` twin: the runner's whole traefik config carries one rule, `HostRegexp(^<project>\.ddev\.site$)`, with no catch-all, so `Host: localhost` is answered 404 on every entrypoint while `Host: <project>.ddev.site:9999` answers 200 — the router strips the port and matches the NAME (all MEASURED), and nothing here registers `additional_hostnames`. The app had carried such an entry since `83897d67` without it ever routing; it was removed rather than fixed, since the two `*.ddev.site` URLs already cover the case. `kind: 'localhost'` stays correct for `appRunnerAccessUrls`, whose port is published straight off the container with no router in front. Routing itself survives a port mismatch (the router strips the port before matching, MEASURED at 200 on a deliberately wrong one); the pin exists so the printed URL is right, and `decideMailpitHostUrls` drops a host link whose reported port disagrees with the published one, since a project's own `.ddev/config.yaml` OVERRIDES the global pin. The in-app "Open Mailpit" button is its own `runtime-ensure` job name, NOT a field on ENSURE — every ENSURE enqueue shares `jobId: ensure-<taskId>` and BullMQ coalesces on it, dropping a second payload silently — and it carries no URL, which the worker resolves itself so the route cannot aim that browser anywhere else. It navigates to the http URL: the runner's Chromium keeps a trust store separate from the system one curl uses, and an interstitial would land the user on a warning page instead of their mailbox.
