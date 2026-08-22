# nimble-browsing-lovelace — user-selectable browser type and version

Status: Not started — deliberately deferred
Origin: raised 2026-08-22 while fixing the Ubuntu browser defect (`0580c51`).

## Context

Browser testing currently gets exactly one browser, chosen by us, at whatever version the
package source serves that day. `renderDockerfile` installs `chromium` on Debian bases and
`google-chrome-stable` on Ubuntu, both unpinned, and every consumer reaches it through the
single hardcoded path `/usr/bin/chromium`.

The ask: let the user say WHICH browser and WHICH version their project should be tested in —
two dropdowns, browser type then version — so a project that must work on a specific Chrome,
or on Firefox, can be verified against it.

Explicitly NOT a QA product. Haive is a development / task tool. Multi-browser and
multi-version matrix testing, device emulators and the rest are what dedicated services
already do well. If that is ever wanted it should arrive as its own task TYPE (a QA task that
spins several browsers), not by growing this feature sideways. This entry covers only:
pick one browser, pick its version, use it for the existing browser-verification steps.

## The blocking constraint, before any UI work

**`chrome-devtools-mcp` speaks the Chrome DevTools Protocol and cannot drive Firefox.** The
agent-facing browser path — 08a's `mcp` mode, the browser-MCP fix loop, Gate 2's evidence — is
entirely CDP. So "Chrome or Firefox" is not one dropdown behind one code path; it is two
automation stacks:

- **Agent/MCP path** (`chrome-devtools-mcp`): Chromium-family only.
- **Probe path** (`browser-check.js`, `browser-probe-connect.js`): puppeteer-core, which does
  support Firefox over WebDriver BiDi.

A Firefox selection would therefore either degrade to probe-only verification (no agent
browser tools), or require a second MCP server that speaks BiDi. Decide which BEFORE offering
Firefox in a picker, because silently degrading the agent path is exactly the failure mode F7
already recorded — a browser step that passes without a browser.

## Feasibility per browser

| Browser | Binaries available | Drivable by the agent (CDP) | Notes |
|---|---|---|---|
| Chrome | Yes — Chrome for Testing publishes every version with download URLs | Yes | The natural first target |
| Edge | Yes — Microsoft apt repo | Likely (Chromium-based), unverified | Cheap to add once Chrome works |
| Opera | Yes | Likely (Chromium-based), unverified | Low demand, verify before promising |
| Firefox | Yes — Mozilla archives all releases | **No** | Needs BiDi; see the constraint above |
| Safari | **No** | n/a | macOS only. WebKit builds are not Safari. Do not offer it |

## Where the version list comes from

Chrome for Testing publishes `known-good-versions-with-downloads.json`, which is the only
source that lists more than "current stable" — Google's apt repo carries stable only. So a
version PICKER implies Chrome for Testing, while the current fix deliberately uses apt.

Those are reconcilable and should be combined rather than chosen between: **install
`google-chrome-stable` from apt for its dependency graph, then overlay the selected Chrome for
Testing build and point the symlink at it.** apt resolves the ~15 system libraries the zip does
not carry (MEASURED absent from the env image: libnss3, libasound2, libatk, libcups, libpango,
libxkbcommon, libatspi), and CfT supplies the exact version. Neither source can do both jobs.

The list should be cached and refreshed the way tool versions already are — `versionSource` in
`packages/shared/src/tooling/tool-install-metadata.ts` plus the existing `REFRESH_VERSIONS`
job — rather than fetched live in a form render. That machinery already exists for npm, pypi,
gem and github-releases sources; this would add one more kind.

## Where it plugs in

- **Declaration**: `01-declare-deps` already renders the browser-testing toggle and carries
  `chromeDevtoolsMcpVersion`; browser type + version belong beside it in `declaredDeps`.
- **Image**: `renderDockerfile`'s browserTesting block, which after `0580c51` is already
  base-aware and ends with a `RUN /usr/bin/chromium --version` assertion.
- **Launch**: `SANDBOX_CHROME_PATH` in `mcp-config.ts` and `CHROME_PATH`. If the symlink
  contract is kept, neither needs to change — which is the main reason to keep it.

## Prerequisite worth doing first, independently

Pin the browser. It is currently unpinned on both bases, so two templates built a week apart
get different browsers with no commit of ours — the drift `DDEV_VERSION` and
`PUPPETEER_CORE_VERSION` are both pinned to prevent, with comments saying so. An `ARG` plus a
`versionSource` entry gives reproducibility now and becomes the field the picker writes into
later. That is a small change and does not need this plan.

## Storage, if this ever grows past one browser

Do not bake several browsers or versions into env images. Chrome alone is ~164 MB with its
dependencies, and every browserTesting template pays it. If multiple versions are ever wanted,
they belong in a shared, mounted store populated once per host — the pattern `npm-cache.ts`
already uses for the npx cache, and the same reasoning as the BuildKit cache-mount work.

## Out of scope

Multi-browser matrices, emulators, device profiles, and anything resembling a QA product.
Those want their own task type, not a wider dropdown here.

# Amendment — 2026-08-22: the "prerequisite" above is wrong, pinning is not separable

The body calls pinning the browser "a small change [that] does not need this plan". That is
incorrect and the correction matters, because it moves work INTO this plan rather than ahead
of it.

MEASURED against the live package indexes: Google's apt repo publishes exactly ONE
`google-chrome-stable` (151.0.7922.173-1 on the day of writing) with no archive of older
builds, and Debian carries one `chromium` per suite. So `apt-get install google-chrome-stable=
<version>` resolves today and starts FAILING the day upstream publishes the next release — a
build that breaks on someone else's schedule, which is strictly worse than the drift it was
meant to fix.

Pinning therefore requires the Chrome for Testing overlay this plan already describes, since
CfT is the only source that archives every version. It is not a prerequisite; it is the same
work.

What shipped instead, as the honest partial: the browserTesting block now writes the installed
version to `/etc/haive-browser-version` on the same line that asserts a browser exists. The
drift is unchanged but is now legible from the image rather than inferred from its build date,
and that file is the natural thing for a future picker to compare against.
