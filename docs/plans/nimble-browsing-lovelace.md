# nimble-browsing-lovelace — user-selectable browser type and version

> **Shipped for Chrome and Edge**, each gated on a verified CDP handshake: `dde9c36` (pinned
> Chrome), `bc1b209` (catalog + picker), `abb5609` (Edge). `01-declare-deps` offers a browser and,
> per browser, a version, both fed by a cached catalog refreshed with the other version feeds.
> **Opera REJECTED on evidence** — release builds do not expose CDP. **Firefox excluded as a COST
> decision, not an impossibility.** Both verdicts are recorded in Feasibility below. A historical
> record for the shipped half; the Firefox path is still open work.
>
> Origin: raised 2026-08-22 while fixing the Ubuntu browser defect (`0580c51`).

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
| Edge | Yes — Microsoft apt repo | **Yes, verified** | Shipped `abb5609`. 39 majors (95 → 151) from 184 debs |
| Opera | Yes | **No — REJECTED** | See below |
| Firefox | Yes — Mozilla archives all releases | **No over CDP** | Feasible via `@playwright/mcp`; a cost decision, see below |
| Safari | **No** | n/a | macOS only. WebKit builds are not Safari. Do not offer it |

**Opera does not expose CDP.** MEASURED on `opera-stable` 135.0.5973.41 installed from
deb.opera.com: launched headless with `--remote-debugging-port=9222`, the port is still REFUSED
after 25 seconds and the process never binds it (listening ports were 8342/9A58/9A60 hex — 9222 is
0x2406 and absent). `--dump-dom about:blank` likewise produced no DOM. Release-build Opera disables
remote debugging, so `chrome-devtools-mcp` times out on the first `tools/call`. Nothing was built
for it. This is why each type is gated on a verified handshake rather than shipping the dropdown
first: Chromium-based was a reasonable prior and it was wrong.

**Firefox is feasible after all, via Playwright MCP — read the exclusion as cost, not
impossibility.** MEASURED against the npm registry 2026-08-23: `@playwright/mcp` (Microsoft), latest
0.0.79 published 2026-08-06, not deprecated, and its `--browser` flag takes
`chrome, firefox, webkit, msedge` — so Firefox is first-class and **webkit** comes with it, closing
the one gap called impossible on Linux (WebKit is not Safari, but it is the engine, and nothing else
on Linux gets closer). `@modelcontextprotocol/server-puppeteer` is deprecated and no dedicated
`firefox-mcp-server` package exists, so Playwright MCP is effectively the only maintained route.
`chrome-devtools-mcp` cannot be made to serve because of protocol divergence rather than a missing
feature: it speaks CDP and Firefox's automation story is WebDriver BiDi. What adopting it would cost
is in Out of scope below.

**What the gating bought.** Each type was proven before being offered, and each proof covered the
whole chain rather than just "a browser exists": the pinned version installs and reports ITSELF
(Chrome 140 not stable 151; Edge 149 not newest 151), `chrome-devtools-mcp` completes initialize /
navigate_page / get_network_request against it over CDP, and the credential controls still hold
through it — body diverted to `/tmp/haive-net-...`, `set-cookie` rendered `<redacted>`, neither
secret in the model-visible text. The generator-rendered Dockerfile was then built for itself in
both cases, not just a hand-written equivalent.

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

## Pinning is NOT separable from this plan

Pin the browser. It is currently unpinned on both bases, so two templates built a week apart
get different browsers with no commit of ours — the drift `DDEV_VERSION` and
`PUPPETEER_CORE_VERSION` are both pinned to prevent, with comments saying so. An `ARG` plus a
`versionSource` entry gives reproducibility now and becomes the field the picker writes into
later.

**It is not, however, "a small change that does not need this plan" — that reading was wrong and
the correction moves work INTO this plan rather than ahead of it.** MEASURED against the live
package indexes: Google's apt repo publishes exactly ONE `google-chrome-stable` (151.0.7922.173-1 on
the day of writing) with no archive of older builds, and Debian carries one `chromium` per suite. So
`apt-get install google-chrome-stable=<version>` resolves today and starts FAILING the day upstream
publishes the next release — a build that breaks on someone else's schedule, which is strictly worse
than the drift it was meant to fix. Pinning therefore requires the Chrome for Testing overlay this
plan already describes, since CfT is the only source that archives every version.

The honest partial that shipped first: the browserTesting block writes the installed version to
`/etc/haive-browser-version` on the same line that asserts a browser exists. The drift is unchanged
but is legible from the image rather than inferred from its build date, and that file is the natural
thing for a picker to compare against.

**The version stories were not alike, and the obvious assumption was backwards.** Edge turned out to
be the SIMPLEST to pin and Chrome the hardest: Google publishes exactly one `google-chrome-stable`
and keeps no archive, while Microsoft keeps old debs, so `apt-get install
microsoft-edge-stable=<version>` does everything for Edge and CfT plus a dependency graph is needed
for Chrome. The Chrome path's one real problem was solved by `apt-get satisfy`. A CfT zip carries no
system libraries, and installing `google-chrome-stable` merely to obtain them would put a second
browser on the wire (~164 MB) only to overwrite it. Taking Chrome's `Depends` from its own package
metadata and handing that string to `satisfy` installs 121 packages and NOT the browser. Installing
those dependency NAMES directly does not work — MEASURED, "Package 'libasound2' has no installation
candidate" on Ubuntu 24.04, because two packages Provide that name and apt refuses to choose, while
satisfy's constraint-aware resolver picks libasound2t64.

## Storage, if this ever grows past one browser

Do not bake several browsers or versions into env images. Chrome alone is ~164 MB with its
dependencies, and every browserTesting template pays it. If multiple versions are ever wanted,
they belong in a shared, mounted store populated once per host — the pattern `npm-cache.ts`
already uses for the npx cache, and the same reasoning as the BuildKit cache-mount work.

## Out of scope

Multi-browser matrices, emulators, device profiles, and anything resembling a QA product.
Those want their own task type, not a wider dropdown here.

**Firefox and WebKit, for now.** Feasible via `@playwright/mcp` (above), and the cost is three
things, none fatal, all real, and none of them a dropdown entry:

1. **Our prompts name chrome-devtools tools directly** — MEASURED, 11 references in
   `_agent-templates.ts` and 1 in `08a-browser-verify.ts`. Playwright MCP has its own tool names and
   a different surface, so the browser-tester template needs a parallel vocabulary and 08a needs to
   know which one it is driving.
2. **Neither credential control carries over.** `--redact-network-headers` and the body diversion
   proxy both target chrome-devtools-mcp specifically. Playwright MCP offers `--secrets`,
   `--storage-state`, `--isolated` and `--output-dir` — adjacent mechanisms solving related
   problems, NOT equivalents. Shipping Firefox without re-establishing those would quietly reopen
   exactly what `139dc14` and `e066d26` closed, and they were expensive to prove.
3. **Two servers or a swap.** Both running means agents see overlapping browser toolsets and can
   pick the wrong one; swapping wholesale loses the CDP-only tools the Chrome path has.

If it is ever wanted, sequence it through the same gate that rejected Opera, in the same order:
prove the handshake for the target browser, re-establish the credential controls on the Playwright
path and verify them the way the Chrome and Edge paths were verified (body diverted, `set-cookie`
redacted, neither secret in the model-visible text), and only then offer the type. Roughly the size
of the Chrome and Edge work combined, not an addition to it.
