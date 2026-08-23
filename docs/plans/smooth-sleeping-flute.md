# smooth-sleeping-flute — honour a declared Ruby version, and give the Ruby block its own compiler

Status: IMPLEMENTED 2026-08-23 — shipped as two commits, 39af246 (toolchain) and 72ebac5
(versioning). Verified by BUILDING the rendered Dockerfiles, not only by unit test:

    3.4.6: ruby 3.4.6 from /opt/hostedtoolcache, solargraph 0.60.3, native gem EXIT=0
    2.7.8: ruby 2.7.8p225, openssl 1.1.1w, native gem EXIT=0, solargraph absent by design

Three deviations from the plan below, each forced by something measured during
implementation:

1. Commit 1 adds `build-essential` ONLY, not `libyaml-0-2`. apt's ruby3.2 already depends on
   libyaml (VERIFIED — psych loads and rubygems works on that path once a compiler exists),
   so libyaml belongs to the tarball path and is listed only there.
2. The plan said an unresolved version would keep the "declared … NOT honoured" Dockerfile
   comment. It cannot: `versions.ruby` now carries only RESOLVED versions, so the generator
   never sees the raw one. Worse, the form note alone would be silent on the reused-values
   path, where the form is auto-submitted and nobody sees it. Closed with a `ctx.emitProgress`
   line in apply(), which costs no declaredDeps key and therefore no rebuild.
3. NEW, and not foreseen: honouring a legacy version made `gem install solargraph` fail the
   image build. Its rubocop chain pulls `parallel`, which requires Ruby >= 3.3, and pinning
   solargraph does NOT help — MEASURED, unpinned, 0.47.2 and 0.44.3 all fail on 2.7.8, while
   RubyGems backs off cleanly from 3.0 up (3.0.7 -> 0.58.3; 3.1.7/3.2.9/3.3.9 -> 0.60.3).
   Below the measured 3.0 floor the install is now SKIPPED with the reason in the Dockerfile,
   rather than failing the build for exactly the legacy app this feature exists to support.
   Before this change that project silently got apt's 3.2.3 and solargraph analysed it with
   an interpreter the project does not use.

Still not done: `.ruby-version` is read only when a Gemfile is also present, because the
Ruby runtime detection is gated on the Gemfile today. A `.ruby-version`-only project is
still not detected as Ruby at all — widening that gate changes which projects get `ruby` in
their default runtimes, so it was left alone.

## Context

`patient-pinning-kernighan` (shipped, 71c10a9 + 91b56bb) honoured `versions.go` and
`versions.rust` but left Ruby as a deliberate partial: the declared version is recorded in a
Dockerfile comment and explicitly NOT applied, because apt ships exactly one interpreter per
suite. That plan deferred "a version-managed install (rbenv/ruby-build or a versioned PPA)"
to be "decided on its own merits". This is that decision.

Investigating it surfaced a SECOND, unrelated and live defect in the same block, which is why
this plan ships two commits rather than one.

### Finding 1 — the Ruby block has no compiler, and does not own one

MEASURED in a real `ubuntu:24.04`, running exactly what `renderDockerfile` emits today
(`apt-get install -y --no-install-recommends ruby ruby-dev`):

```
toolchain: cc=NONE gcc=NONE make=NONE
headers:   /usr/include/ruby-3.2.0/ruby.h        <- ruby-dev IS installed
gem install bigdecimal   -> extconf failed, EXIT=1
gem install solargraph   -> extconf failed on prism, EXIT=1, binary NOT on PATH
```

`--no-install-recommends` drops gcc, so every native gem extension fails. `gem install` exits
**1**, so the `RUN gem install solargraph` line the generator emits **fails the image build**.

It does not fail for everyone, and the reason is worse than the bug: `build-essential` is
installed by the **node** block, and node is pulled in by `browserTesting`, which defaults to
on. So the Ruby block works only as a side effect of an unrelated block. Rendered today:

| deps | `build-essential` | outcome |
|---|---|---|
| ruby only, browserTesting **off** | absent | **image build fails** |
| ruby only, browserTesting on (form default) | present | ok |
| ruby + node | present | ok |

Adding `build-essential` (and `libyaml-0-2`, below) to the Ruby block's own apt line makes it
self-sufficient. Independent of versioning, so it ships first and alone.

### Finding 2 — a version-managed Ruby is cheap, via prebuilt tarballs

Options tested, not assumed:

- **Brightbox PPA — dead.** `ppa.launchpadcontent.net/brightbox/ruby-ng/ubuntu/dists/noble/Release`
  → **404**. The versioned PPA the prior plan floated does not exist for our base image.
- **rbenv / ruby-build — rejected.** Compiles from source; minutes per image build plus a full
  toolchain, for a layer that is rebuilt whenever declared deps change.
- **`ruby/ruby-builder` toolcache — works.** Prebuilt tarballs, the same source
  `ruby/setup-ruby` uses. Same shape as the Go tarball already in this file and the
  Chrome-for-Testing zip already used for the pinned browser.

MEASURED in `ubuntu:24.04`, extracted and run:

| Ruby | runs | stdlib + openssl | `gem install rake` |
|---|---|---|---|
| 2.7.8 | yes | OpenSSL **1.1.1w**, bundled in the tarball | ok |
| 3.0.7 | yes | OpenSSL 1.1.1w, bundled | ok |
| 3.2.9 | yes | system OpenSSL 3.0.13 | ok |
| 3.4.6 | yes | system OpenSSL 3.0.13 | ok |

Legacy rubies carry their own OpenSSL 1.1 — the hard part of running a legacy Rails app on
noble, already solved upstream. Tarball ~41.6 MB gz.

Two traps, both measured:

1. **NOT relocatable.** Extracted anywhere other than its build prefix:
   `error while loading shared libraries: libruby.so.3.4`. Must land on
   `/opt/hostedtoolcache/Ruby/<version>/x64` — the path `ruby/setup-ruby` uses, for this reason.
2. **Needs `libyaml-0-2`.** Without it psych fails to load, which breaks `gem install` itself.
   One apt package covers every version.

### Finding 3 — the version list must come from the assets, not the manifest

`ruby/setup-ruby`'s `ruby-builder-versions.json` is only 2.9 KB and lists 134 CRuby versions,
but it is **OS-agnostic and over-claims**: it offers `4.0.6`, which has **no ubuntu-24.04
build**. Using it would hand out versions that 404 at image-build time.

The release-assets payload is authoritative: `releases/tags/toolcache` returns 1.78 MB with
**all 919 assets inline** (no pagination), of which **95** match
`^ruby-<version>-ubuntu-24.04.tar.gz` across 13 minor lines (2.0 → 3.4, newest 3.4.6).
The anchors matter — an unanchored match also catches `jruby-`/`truffleruby-` and the `-arm64`
variants. `ruby-3.5.0-preview1` is excluded by requiring a numeric patch, which is intended.

### Finding 4 — `.ruby-version` is never read

`scanRepoForDeps` reads only the Gemfile `ruby` directive. `.ruby-version` — where a full
version usually lives — is ignored, and the modern `ruby file: ".ruby-version"` Gemfile form
yields null (VERIFIED: the regex correctly captures nothing rather than mis-capturing).

## Approach

Two commits.

### Commit 1 — Ruby block owns its toolchain

One line in the Ruby block of `renderDockerfile`
(`packages/worker/src/step-engine/steps/env-replicate/02-generate-dockerfile.ts`): add
`build-essential libyaml-0-2` to its existing apt install alongside `ruby ruby-dev`.

Fixes native gems and the solargraph LSP install for a Ruby-only project, and removes the
accidental dependency on the node block. `build-essential` being installed twice when node is
also declared is a no-op for apt and both blocks already share the BuildKit cache mounts.

### Commit 2 — honour the declared version

**Catalog** (mirrors `browser_version_cache` end to end):

- `packages/database/src/schema/env.ts` — `runtimeVersionCache` table, `runtime` varchar PK,
  `versions` jsonb `{version,label}[]`, `fetchedAt`, `fetchError`, `updatedAt`. Named for the
  key rather than for Ruby, exactly as `browser_version_cache` covers two browsers.
- `packages/database/src/migrations/0128_runtime_version_cache.sql` — `CREATE TABLE IF NOT
  EXISTS`, additive and idempotent, modelled on `0127_browser_version_cache.sql`.
- `packages/worker/src/cli-versions/ruby-versions.ts` — `parseRubyBuilderAssets` (pure,
  exported for test) + `refreshRubyVersions(db)`. Follows `refreshBrowserVersions`'s contract
  exactly: bounded fetch timeout, **records its error on the row and returns rather than
  throwing** (it shares REFRESH_VERSIONS and must not fail the job or wipe sibling caches),
  and treats a successful fetch that parses to 0 entries as an error rather than overwriting
  a good cache with nothing.
- `packages/worker/src/queues/cli-exec/handlers.ts` — call it in the existing
  `Promise.all` beside `refreshBrowserVersions` (it reads no other cache, so nothing to race),
  and fold its result into the `ok`/`refreshed`/`errors` aggregation.

**Resolution** (`01-declare-deps.ts`) — the form field stays free text:

- `scanRepoForDeps`: read `.ruby-version` and prefer it over the Gemfile directive (it is the
  more specific, usually-full declaration).
- `detect()`: read the cached catalog defensively on both axes — `ctx.db.query.runtimeVersionCache?.…​.catch(() => [])`
  — copying the comment and shape already used for `browserVersionCache`, so a client whose
  schema predates the table cannot break environment declaration. Resolve the detected version:
  exact match wins; a two-part `3.1` resolves to the newest patch on that line; no match
  resolves to null. Carry the resolution on `DeclareDepsDetect`.
- `form()`: when a version is declared but unresolved, render a `note` field saying it cannot
  be honoured and that apt's interpreter will be used (the `toolingLink` note is the existing
  precedent for a `note` field in this form).
- `apply()`: write `versions.ruby` **only when resolved**, as the full version. Keeps the
  existing conditional-key rule that protects `envTemplateHash` — an unresolvable or absent
  version leaves the key off and the environment hashes exactly as it does today.

**Render** (`02-generate-dockerfile.ts`): when `versions.ruby` is a full `X.Y.Z`, extract the
tarball to `/opt/hostedtoolcache/Ruby/<v>/x64`, `ENV PATH` in front (same shape as the Go and
Rust blocks), and keep `libyaml-0-2 build-essential` from commit 1. Otherwise render today's
apt path with the existing "declared … NOT honoured" comment. `isPlainVersion` already guards
the interpolation against the newline-escape class of defect fixed in 91b56bb. No `GEM_HOME`
is needed — VERIFIED that `gem install` writes inside the prefix and works.

The Ruby block must stay ahead of the LSP block so `gem install solargraph` sees the new
interpreter; it already is.

### Deliberately out of scope

A select/dropdown of the 95 builds (the text field plus resolution keeps an exact `.ruby-version`
pin working), jruby/truffleruby, arm64, and any admin toggle — this adds no `CONFIG_KEYS`
entry, and the browser catalog it mirrors has no admin surface either. A version the catalog
lacks is escaped by hand-editing the Dockerfile at step 02, which is already a first-class
feature.

## Rollback

- Commit 1: revert one line.
- Migration: additive `CREATE TABLE IF NOT EXISTS`; undo is `DROP TABLE runtime_version_cache`,
  which loses only a cache the next REFRESH_VERSIONS rebuilds.
- Commit 2 code: `versions.ruby` is written only when resolved, so reverting the code returns
  every environment to the apt render. Templates that already carry a resolved `versions.ruby`
  re-render the apt path plus the "not honoured" comment — no broken state, no data migration.
- Neither commit changes an existing environment's hash unless Ruby is actually declared and
  resolvable, so nothing else on the install rebuilds.

## Verification

1. `packages/worker/test/ruby-versions.test.ts` — parser against a recorded slice of the real
   assets payload: excludes `jruby-`/`truffleruby-`/`-arm64`/`-preview1`, keeps `2.0.0-p648`,
   sorts newest-first. Mirrors `test/browser-versions.test.ts`.
2. `packages/worker/test/env-dockerfile-pins.test.ts` — resolved full version renders the
   tarball at the canonical prefix; unresolved renders the apt path and the "not honoured"
   comment; absent renders byte-identically to today (the hash-stability test already there).
3. Resolver unit test — exact, two-part→newest-patch, no-match→null, empty catalog→null.
4. `pnpm vitest run` + `tsc --noEmit` + `prettier --check` in the worker container (no host
   build — it poisons the bind-mounted dist).
5. **End-to-end, the step the prior plan skipped**: render a Dockerfile for a Ruby project and
   actually `docker build` it, then in the image assert `ruby -v` matches the declared version,
   `gem install bigdecimal` succeeds (native ext), and `solargraph --version` runs. Repeat for
   a legacy pin (2.7.8) and for an unresolvable version (must build via apt, not fail).
6. Run `handleRefreshCliVersionsJob` against the dev DB and confirm `runtime_version_cache`
   holds a ruby row, and that a forced fetch failure records `fetch_error` without failing the
   job or clearing the sibling caches.
