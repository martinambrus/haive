# patient-pinning-kernighan — runtime versions the spec can express but the generator ignores

Status: Not started
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
