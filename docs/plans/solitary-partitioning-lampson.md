# solitary-partitioning-lampson — Per-install namespacing

> **S0-S3 SHIPPED 2026-09-08; S4 is the two-install verification.** `HAIVE_INSTALL_ID` (default
> `haive`) names every Docker container, volume, network and image and every Postgres database an
> install owns, through one module in `@haive/shared`. The default output is byte-identical to what
> shipped — asserted family by family in `naming.test.ts`, and proven at the compose layer by
> diffing `docker compose config` against the previous file (identical: 297 lines for the run
> overlay, 467 for the dev overlay) — so no install has to be migrated or renamed.
>
> Two Haive installs cannot share a machine today, and the failure is not a clean refusal. This plan
> makes every docker and Postgres resource an install OWNS carry that install's identity, so a
> published install and a dev checkout can run side by side — which is also what makes the upgrade
> path testable with the worker running.

## The problem, measured

Compose gives each project its own namespace, and this stack overrides that in three places. All
three are GLOBAL to the daemon:

| Layer | What | Collision |
|---|---|---|
| Compose-declared | 11 × `container_name`, 3 networks with an explicit `name:`, 6 volumes with an explicit `name:` | Containers and networks clash LOUDLY |
| | `haive_repos`, `haive_bundles`, `haive_wrappers`, `haive_squid_configs`, `haive_ddev_ca` | Volumes **SHARE SILENTLY** |
| Runtime-constructed | the worker builds names in TypeScript, not in compose | shares or clashes depending on the family |
| Postgres | `haive_rag_<project>`, `haive_kb_global` | **two installs mix each other's indexed data** |

The silent half is the dangerous half. A second install mounts the first one's cloned repositories
and its worker acts on them; its RAG queries read the first install's vectors. Nothing errors.

**Runtime-constructed families**, none of which a compose-level prefix would touch:

- sandbox and terminal containers — `haive-cli-<id>`, `haive-shell-<id>`
- runtime runners — `haive-ddev-<project>`, `haive-ddev-runner`
- auth volumes — `haive_cli_auth_<user>_<cli>_<n>`, `haive_cli_auth_task_<slug>_<cli>_<n>`
- IDE volumes — `haive_ide_udata_*`, `haive_ide_ext_*`
- sandbox networks — `haive-sandbox`, `haive-models`
- the base image tag — `haive-cli-sandbox`
- Postgres databases — `haive_rag_<project>`, `haive_kb_global`

## Why it is worth doing rather than working around

- **Coexistence is the point.** Running a published install beside a dev checkout is the thing this
  unlocks, and it is wanted for its own sake, not only for a test.
- **It makes the upgrade path testable with the worker.** Today an install test has to exclude the
  worker, because its boot reapers are database-driven: a second install with an empty database sees
  every `haive_cli_auth_task_*` volume as an orphan and removes it. That was survivable during the
  2026-09-08 Windows boot test only because those volumes are ephemeral and `ensureTaskAuthVolumes`
  recreates them per invocation. It is not survivable for anything that shares state.
- **The silent sharing is a data-integrity bug**, not an inconvenience, and it will bite the first
  person who tries what looks like an obvious thing.

## Design

**One INSTALL ID, never the version.** `HAIVE_INSTALL_ID`, defaulting to `haive`.

The name must identify the INSTALL, not what it currently runs. A version in the name renames every
container on every upgrade and renames them back on a rollback — breaking anything that holds a
name, and cutting logs and monitoring in half at each release. The version already lives in the
image tag and at `/version`, which is where a value that changes belongs. This was raised as
version-in-name and is recorded here as the reason it is not that.

**The default reproduces today's names byte for byte**, so an existing install is unchanged and
nothing has to be migrated or renamed. That is what makes this shippable at all.

- **Compose:** `${HAIVE_INSTALL_ID:-haive}-api`, and the same for the networks and the six named
  volumes.
- **Worker:** one `resourceName()` module in `@haive/shared` that every constructor goes through.
  No string literal `haive_…` may remain at a call site; the point is that there is exactly one
  place that knows the shape of a name.
- **Postgres:** the RAG and global-KB database names take the same prefix.

### Labels, not just names — the half this plan originally missed

**Most reapers select by LABEL.** `reapAllCliSandboxes` sweeps `label=haive.task.id` on every
worker boot, preemption keys on `haive.invocation.id`, the runtime reaper on `haive.ddev` — and
those keys are identical in every install. So namespacing names alone would still have let a
second install's worker force-remove the first one's RUNNING agent sandboxes, which is worse than
the silent volume sharing this plan was written for.

Every container Haive creates now carries `haive.install=<id>`, and the ownership test lives in
code rather than in a `docker ps --filter`, because a filter cannot express "this value OR absent"
— and absent is exactly what every container predating the label is. The rule is deliberately
asymmetric: the DEFAULT install claims unlabelled resources, or its reapers would stop recognising
every container already on the host and leak them forever with nothing reporting it; a NON-DEFAULT
install never claims them, because claiming means force-removing.

### The id cannot contain a hyphen, and compose is what decides that

The id is interpolated into `docker-compose.yml` as BOTH `${HAIVE_INSTALL_ID}-api` and
`${HAIVE_INSTALL_ID}_repos`, and compose cannot transform a value between the two conventions. An
id containing `-` would therefore have to be folded for volumes — which the code half can do and
the compose half cannot, leaving one install naming two different volumes. So `[a-z0-9_]` only,
rejected at the boundary. Lower case for the same class of reason: Postgres folds an unquoted
identifier, so two ids would name one database.

### The hard part is the reapers, not the names

Several reapers select what to delete by matching these prefixes —
`haive_cli_auth_task_` (`auth-volume-reaper.ts`), the `haive-cli-*` sandbox sweep, the composed-image
and env-template reapers. A prefix change that reaches the CONSTRUCTORS but not the FILTERS produces
one of two failures, and both are worse than the bug being fixed:

- filter too narrow → resources leak forever, with nothing reporting it;
- filter too broad → **one install reaps another's containers, volumes and databases**.

So the filters must be derived from the same module as the constructors, not written alongside
them, and a test must assert that every reaper's filter is generated rather than typed. This is the
part to design first and the part most likely to be got wrong.

### Changing the ID of an existing install is not a rename

It ORPHANS everything that install owns: its volumes, its databases, its containers keep the old
name and nothing looks for them any more. The tool must refuse to change it on a populated install
rather than silently stranding the data — or, if that is ever wanted, it is a migration with its own
plan, not a flag.

## Slices

**S0 — the naming module. SHIPPED.** Pure, exported from `@haive/shared`, with tests covering every family
above and an explicit test that the default output equals today's literal names. No behaviour
change; nothing consumes it yet. *Rollback: delete the module.*

**S1 — route the worker through it. SHIPPED.** Replace every runtime constructor, and derive every reaper
filter from the same module. *Rollback: revert; the default output is byte-identical, so a partial
revert cannot orphan anything.* Verify: with the default id, `docker volume ls` / `ps` after a real
task are indistinguishable from before.

**S2 — compose. SHIPPED.** The 11 container names, 3 networks, 6 volumes. *Rollback: revert the file.*

**S3 — Postgres databases. SHIPPED.** `haive_rag_<project>` and `haive_kb_global`. The fallback
this slice anticipated turned out to be unnecessary rather than skipped: at the default id the
prefixed name IS the bare name, so a repo indexed before this existed resolves to the same database
with no second lookup.

**S4 — verify by doing the thing. The guard that keeps S0-S3 true is
`resource-naming-guard.test.ts`**, which fails the build on any resource-name literal typed outside
the naming module. Source-level rather than behavioural, because the failure mode IS a literal in
the source and a behavioural test would need two installs against a real daemon to see it. It found
three genuine misses on its first run: `sandbox-runner.ts`'s image and wrapper-volume defaults, and
`IN_STACK_OLLAMA_HOSTS`, which matched the ollama container by literal name — so a second install
would have read its own in-stack daemon as an external endpoint, changing how the run is priced and
routed.

**S4 — verify by doing the thing.** Two installs on one machine at once: a published release and a
dev checkout, both with a worker running, each creating sandboxes and RAG stores. Then confirm each
one's reapers leave the other's resources alone — which is the assertion this whole plan exists for.

## Open questions

- **`HOST_REPO_ROOT_REAL` on Windows.** The worker needs the DAEMON's view of the host path when it
  emits bind mounts into sandbox containers. On a Windows install `HOST_REPO_ROOT` is a Windows path
  and nobody has checked what the translation needs to be. Unrelated to namespacing except that both
  bite the same install, and it will surface the first time a Windows install runs a real task.
- Whether the install id should also appear in the compose PROJECT name, or whether leaving that to
  the directory is enough. Probably enough, but it should be a decision rather than an omission.
