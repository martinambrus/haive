# Task browser

`BrowserVncPanel` relies on noVNC's canvas keyboard handler to cancel and forward
input while the canvas is focused. Reserved outer-browser shortcuts (Ctrl+W,
Ctrl+Tab and similar) require real browser fullscreen, not the Maximize overlay.
`keyboard-fullscreen.ts` requests `requestFullscreen({ keyboardLock: 'browser' })`
for Firefox 151+ and Safari; Chromium additionally uses `navigator.keyboard.lock()`.
Fullscreen includes the panel controls so Exit fullscreen stays reachable when
Escape is forwarded; holding Escape is the browser's escape hatch. Entry focuses
the RFB canvas, including reconnects in fullscreen. Exit, hide, auto-collapse and
unmount release any owned Chromium lock. A denied capture request is shown to the
user without disconnecting VNC. Never add a page-wide shortcut handler or emit
duplicate RFB key events: noVNC handles layout, modifiers and key releases itself.
Older browsers can ignore the fullscreen option, so entering fullscreen alone does
not prove capture is available.

`/settings/keyboard-test` uses the same fullscreen helper without a VNC connection.
Its focused capture area records only the last 80 keydown/keyup events in memory
(key, physical code, modifiers, cancellation and repeat); it sends nothing to the
server. Compare physical input through RustDesk with input directly at the PC to
isolate interception before the page. Synthetic browser automation can verify DOM
delivery and RFB forwarding, but cannot establish whether RustDesk or OS/browser
reserved shortcuts deliver physical events. References: [Fullscreen keyboard
locking](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen#keyboard_locking),
[Mozilla's Ctrl+Tab fix](https://bugzilla.mozilla.org/show_bug.cgi?id=2034292).

One browser per task, one TAB per agent. Every sandboxed CLI of a task gets the same `--browser-url` (`resolvers.ts` probes the runner once per invocation), and chrome-devtools-mcp selects `pages[0]` on connect — so N concurrent agents drive ONE tab unless told otherwise. They are told otherwise by `BROWSER_TAB_DISCIPLINE` (`sandbox/mcp-surface.ts`), which rides the MCP surface block and therefore reaches every browser-capable dispatch: llm, mining (`08d-adversarial-qa`, the only fan-out keeping the full surface) and `dag_parallel` coders. `isolatedContext` is banned there rather than unmentioned — it is the obvious-looking way to isolate and it starts a fresh cookie jar, discarding the one deterministic app login `_app-auth.ts` performs per task. Tab 0 is the human's view: `browser-probe-connect.js` and `browser-login.js` both reuse `pages[0]` and bring it to front. A per-agent headless browser is NOT the alternative — it cannot reach a `*.ddev.site` or app-runner URL from the cli-exec sandbox, and carries no login. Agents killed before their `close_page` are swept by `closeExtraBrowserTabs` (`browser-close-extra-tabs.js`) at the mining and DAG barriers ONLY, never at browser bring-up, which runs while a human may have tabs open. The tab it keeps is the one RECORDED as the human's (`browser-human-tab.js`, written by `browser-probe-connect.js`/`browser-login.js` at the moment they `bringToFront()` a tab, read back as a CDP `Target.getTargetInfo` id), never inferred from the tabs. Three inference attempts have been MEASURED lying: `browser.pages()` is not creation order (two probes minutes apart put the newest tab at index 0 and then the oldest, so an early keep-`pages[0]` version closed the app tab the human was watching), `/json/list` is a third order again, and `document.visibilityState` — which replaced them — reported `visible` for BOTH tabs of a two-tab window (identical `windowId` and bounds), along with `document.hidden` false, `hasFocus()` true, animation frames and screencast frames, so the sweep failed safe and closed nothing on exactly the runners that leak. No record, an unreadable one, or a recorded tab that is no longer open still closes NOTHING; a leaked tab costs memory, closing the wrong one costs work. The launch script also restores puppeteer's three anti-backgrounding switches, since with a tab per agent all but one are always in the background — the likeliest reason no page-side signal separates them any more.

The same barrier RESTORES THE WINDOW, and Gate 2's bring-up does it again before the human looks (`browser-restore-window.js`, `restoreRunnerBrowserWindow`/`restoreAppRunnerBrowserWindow`). `resize_page` is not viewport emulation: MEASURED in the shipped chrome-devtools-mcp 1.7.0 bundle it un-maximizes the OS window and then sets its bounds so the CONTENT matches, so 08a's deterministic 1280x800 outlives the MCP session — three live runners were sitting at 1280x887 on a 1920x1080 screen. The agents cannot undo it and are not asked to: `resize_page` takes a CONTENT size and there is no window-state tool, so the screen size overshoots the display, and one window serves every agent's tab, so a per-agent restore would resize a sibling mid-screenshot. Restore target is the screen read from the page, NOT the 1920x1080 literal in `start-browser-desktop.sh` and not the launch geometry (Chrome offsets that by 10,10, which would hang 20px off two edges). Chrome settles at 1919x1079 for a 1920x1080 request, so the skip test asks whether the window COVERS the screen rather than matching it, or every barrier would rewrite identical bounds.
