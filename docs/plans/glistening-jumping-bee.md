# Per-agent browser tabs: stop concurrent agents sharing one tab, and reclaim the tabs they leave

## Context

Every sandboxed CLI of a task attaches `chrome-devtools` to the SAME headed Chromium on the
task's runner desktop: `resolveMcpExtraFiles` probes the runner once per invocation
(`queues/cli-exec/resolvers.ts:209` -> `sandbox/runner-browser-cdp.ts`) and passes the same
`--browser-url=http://<runner-ip>:9223` to every one (`sandbox/mcp-config.ts:234`). That is
deliberate and cannot be replaced by a per-agent browser: the headless fallback runs inside the
cli-exec sandbox, where it can reach neither the `*.ddev.site` hostname nor the app-runner URL
(`07-phase-2-implement.ts:305`), and it would not carry the app login that `_app-auth.ts`
performs once for the whole task.

What is NOT deliberate is that every agent also lands on the same TAB. chrome-devtools-mcp
1.7.0 selects `pages[0]` on first connect (`McpContext.createPagesSnapshot`, the
`!this.#selectedPage` branch) and nothing tells an agent to move off it. So with N agents live:

- `navigate_page` / `click` / `fill` from one agent lands in the tab another is mid-`take_snapshot` on.
- `resize_page` is global to that tab, and 08a's screenshot protocol has every tester resize once.
- tab 0 is also the human's view: `browser-probe-connect.js` and `browser-login.js` both reuse
  `pages[0]` and `bringToFront()` it so the VNC panel lands on the app.

Two steps run agents concurrently WITH the browser wired:

- `08d-adversarial-qa` - 2/4/6 adversaries, and the only mining fan-out with the full MCP
  surface (`08d-adversarial-qa.ts:317`; every other `agentMining` step sets `toolProfile: 'rag_only'`).
- `06c-dag-execute` - N coders/reviewers/fix-coders, `mode: 'dag_parallel'`
  (`dag-executor.ts:796,1720`), full surface, one app and one browser between them.

Second problem, same root: nothing closes a tab. `chrome-devtools-mcp` in `--browser-url` mode
disconnects without closing what it opened, so once agents start opening their own tabs the
renderers accumulate in a runner whose RAM is budgeted (browser surcharge 1536 MB,
`runtime-caps`). Measured on the live runner while writing this plan
(`docker exec haive-ddev-de98d843 curl -fsS http://127.0.0.1:9222/json/list`): 2 page targets
already open.

Outcome wanted: each agent works in its own tab, closes it when done, and a barrier reap
reclaims the tabs of agents that were killed before they could.

## Slice 1 - tab discipline in the shared MCP surface prompt

One insertion point covers every browser-capable dispatch: `mcpSurfacePrompt()` in
`packages/worker/src/sandbox/mcp-surface.ts` (its `surface.chromeDevtools.enabled` branch).
`resolveTaskDispatch` resolves the surface itself (`orchestrator/dispatcher.ts:111`) and
`withMcpSurface` prepends the block, so llm steps, mining agents (`step-runner.ts:1323`) and
DAG agents all inherit it. No per-step prompt edits - do NOT add these lines to 08a/08d/07/09.

Append to the existing chrome-devtools bullet:

```
  SHARED browser: sibling agents may be driving it right now, and every session starts pointed
  at tab 0 - the human's view in the VNC panel. Make `new_page({url})` your FIRST browser call
  and stay in that tab; navigating or resizing before it hits whatever tab someone else is on.
  Never pass `isolatedContext` - a fresh cookie jar loses the app login this task already did.
  `close_page` your tab when done; if it refuses as the last open tab, leave it.
```

Constraints this wording satisfies:

- `isolatedContext` creates a separate browser context ("fully isolated" per the tool schema) =
  a fresh cookie jar = the deterministic app login is gone. Plain `new_page` shares the jar.
- `close_page` throws `CLOSE_PAGE_ERROR` when one page remains (`McpContext.closePage`), hence
  the last clause.
- Foreground (the `new_page` default) is intended: a background tab's screenshot is not something
  this codebase has measured, and screenshots are load-bearing evidence for the Gate 2 gallery.
  The cost is that the VNC view follows whichever agent acted last during a fan-out.
- The added lines must NOT contain the literal string `chrome-devtools`:
  `mcp-surface.test.ts:167` asserts it appears exactly once in the rendered prompt.

## Slice 2 - keep background tabs alive (chromium flags)

`packages/worker/docker/ddev-runner/start-browser-desktop.sh` launches Chromium raw - its own
header notes it inherits none of puppeteer's defaults. Missing, and needed once N tabs coexist:

```
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
```

Without them only the active tab keeps full timer/renderer priority, so an agent's `wait_for`
against a timer-driven UI can fail purely because a sibling agent's tab is in front. Add a short
comment in the script's existing style saying these are puppeteer's defaults, restored explicitly
because this launch is raw.

Consequences to expect, not to fix:

- `resolveImageTag` (`sandbox/ddev-runner.ts:70`) hashes this script, so the tag changes and the
  next DDEV runner create rebuilds `haive-ddev-runner` (~2 GB, `pruneOldRunnerImages` clears the
  old tag). Runners already up keep the old flags until recreated.
- The app-runner path needs no rebuild: `injectBrowserAssets` (`sandbox/app-runner.ts:86`)
  docker-cp's the same file from `browserAssetsDir()` on every runner create.

## Slice 3 - barrier reap for tabs nobody closed

An agent killed by the soft timeout, preemption or the orphan sweep never runs its `close_page`.
Deterministic half:

New script `packages/worker/docker/ddev-runner/browser-close-extra-tabs.js`, sibling to
`browser-probe-connect.js` and built the same way (puppeteer-core, connect by `browserURL`,
`disconnect()` - never `close()`):

```js
const puppeteer = require('puppeteer-core');
// connect http://127.0.0.1:9222 -> browser.pages() -> close pages.slice(1) -> disconnect
// print JSON {kept, closed}
```

`browser.pages()` (target creation order) is what makes "keep the first" the right rule: it is
the same ordering `browser-probe-connect.js` and `browser-login.js` already treat as the human's
tab. Do NOT reimplement this over `/json/list` - that endpoint's ordering is not a contract we
have measured, and guessing it wrong closes the human's tab instead of the agents'.

Wiring (mirrors the existing per-runner asymmetry - the two images put the scripts in different
dirs because puppeteer-core is installed in different dirs):

- `docker/ddev-runner/Dockerfile`: `COPY browser-close-extra-tabs.js /opt/browser-close-extra-tabs.js`
- `sandbox/ddev-runner.ts`: add the filename to `resolveImageTag`'s hashed file list (mandatory -
  otherwise a later edit to the script never changes the tag), plus a `closeRunnerExtraTabs(taskId)`
  wrapper next to `runnerBrowserCdpUrl` (line 1609).
- `sandbox/app-runner.ts`: add the filename to `injectBrowserAssets`'s copy list (lands at
  `/opt/browser/browser-close-extra-tabs.js`), plus `closeAppRunnerExtraTabs(taskId)` next to
  `appRunnerBrowserCdpUrl` (line 390).
- `sandbox/runner-browser-cdp.ts`: `closeExtraBrowserTabs(containerName, scriptPath)` doing the
  `docker exec` and swallowing failures, mirroring `browserCdpUrlForRunner`'s shape and its
  "return quietly when the runner/desktop is absent" behaviour.

Call sites - exactly two, both in `step-engine/step-runner.ts` inside `advanceStep`, best-effort
and never fatal:

- after `resolveAgentMiningPhase` resolves (~line 1859)
- after `resolveDagPhase` resolves (~line 1868)

Both are points where every agent of that step has ended, which is the property that makes the
reap safe. Deliberately NOT at `startBrowserDesktop`: bring-up runs while a human may have tabs
open in the VNC panel, and closing those is worse than leaking one. Try the ddev runner, then the
app runner, same as `resolveRunnerBrowserCdpUrl` does.

Known gap, accepted for now: DAG levels checkpoint one at a time, so tabs from level N are only
reclaimed when the whole step ends. A per-level reap inside `dag-executor.ts` is a follow-up, not
part of this change.

## Slice 4 - the one onboarded agent definition that contradicts slice 1

`integration-tester` is the only agent template wired to the browser
(`steps/onboarding/_agent-templates.ts:882`, the sole `mcpTools: ['chrome-devtools']`), and its
"Prepare test environment" step says "1. Launch the browser via the `chrome-devtools` MCP. 2.
Navigate to the base URL" - i.e. it navigates tab 0, which is exactly what slice 1 forbids. 08a's
tester prompt tells the agent to follow that definition when the repo has it
(`agentDefinitionGuidance('integration-tester', ...)`), so leaving it puts two contradictory
orders in one context.

Change step 1 to open its own tab (`mcp__chrome-devtools__new_page({ url })`) and add a closing
line to release it. Checked: the six adversarial templates (`auth-bandit` ... `workflow-disruptor`)
say nothing about a browser at all, so the surface block is their only instruction and they need
no edit.

Per the template rules in CLAUDE.md this is a BODY-ONLY change: do NOT bump `schemaVersion` in
`template-manifest.ts`. The `contentHash` recomputes on worker boot and onboarded repos will
correctly start reporting this template as changed in the upgrade-status endpoint.

## Files touched

- `packages/worker/src/sandbox/mcp-surface.ts` (+ `mcp-surface.test.ts`)
- `packages/worker/src/step-engine/steps/onboarding/_agent-templates.ts` (integration-tester only)
- `packages/worker/docker/ddev-runner/start-browser-desktop.sh`
- `packages/worker/docker/ddev-runner/browser-close-extra-tabs.js` (new)
- `packages/worker/docker/ddev-runner/Dockerfile`
- `packages/worker/src/sandbox/runner-browser-cdp.ts`, `ddev-runner.ts`, `app-runner.ts`
- `packages/worker/src/step-engine/step-runner.ts`

## Verification

1. Unit: `pnpm --filter @haive/worker test mcp-surface` - existing
   `expect(prompt.match(/chrome-devtools/g)).toHaveLength(1)` still passes; new assertions that
   the tab lines render when `chromeDevtools.enabled` and are absent when it is off.
2. Typecheck in-container per the repo rule (`docker exec haive-worker ...`), not on the host.
   `pnpm --filter @haive/worker test agent-baseline` stays green (it validates the template
   schema and manifest, not body text, so a body-only edit must not move it).
3. Flags, on a runner created after the change:
   `docker exec <runner> ps aux | grep -o 'disable-renderer-backgrounding'` returns a match.
4. Reap, against a live browser-testing task, before/after a mining or DAG barrier:
   `docker exec <runner> curl -fsS http://127.0.0.1:9222/json/list | python3 -c "import sys,json;print(len([t for t in json.load(sys.stdin) if t['type']=='page']))"`
   goes to 1, and the VNC panel still shows the app (the kept tab is the human's).
5. End-to-end on a browser-testing repo with `adversarial_qa_level` >= standard: the 08d
   adversaries each report from their own tab, 08a's screenshot gallery still fills
   (`.haive/screenshots`), and an agent hitting an authenticated route is still logged in -
   which is the proof that plain `new_page` kept the cookie jar.

## Rollback

Three independent reverts, no schema and no data: drop the prompt lines (prompt-only, nothing
persisted); drop the three chromium flags (the next runner create rebuilds back to the previous
image hash); delete the two `step-runner.ts` call sites (the script and wrappers become dead code
and can be removed in the same commit).
