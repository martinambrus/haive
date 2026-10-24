---
name: chrome-mcp-browser-check-gotchas
description: "Chrome MCP traps when verifying Haive UI - button-text clicks hit the task-level Cancel or a row's own action button, fill() misses React state, no folder picker, press_key misses window listeners, reading a row before overwriting it, and overflow probes that miss a scrolling main"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f613a72b-ccee-4fa4-b74c-60cef24618b3
  modified: 2026-09-13T11:53:28.826Z
---

When verifying Haive's task page with Chrome MCP:

1. **Never click by matching button text across the whole document.** The task header carries
   `Cancel` (cancels the TASK, with a `confirm()` the MCP auto-accepts by default) and `Retry`
   / `Skip` per step. `querySelectorAll('button').find(b => b.textContent === 'Cancel')` returns
   the header's button, not the one in the component under test. Scope the query to the
   component's container element first.
2. **`fill` / direct `.value =` does not reach a React-controlled input.** React's value tracker
   treats the assignment as the current value, so the dispatched `input` event is skipped and
   state never updates — the save then writes the unchanged seed value and looks like a product
   bug. Use the prototype setter:
   `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, next)`
   then `el.dispatchEvent(new Event('input', {bubbles:true}))`.

**Why:** on 2026-09-04 trap 1 cancelled the user's live `Build plan: vareska-claude` task
(6h of work, parked at 02-plan-coverage) during a verification run, and trap 2 produced a
false "the save wrote the wrong content" reading.

**How to apply:** scope every click to the component, and set React inputs through the
prototype setter. A cancel is recoverable — `cancelTaskRow` (`packages/api/src/lib/cancel-task.ts`)
only sets `tasks.status/completed_at` + flips non-terminal steps to `failed` with
`error_message='Task cancelled'`, so restoring the task row and the parked step row brings the
gate back with its form intact.

3. **CDP cannot drive a folder picker.** `upload_file` (`DOM.setFileInputFiles`) takes file
   paths only, and `File.webkitRelativePath` is read-only — so an `<input webkitdirectory>`
   cannot be exercised end-to-end in the browser. Verify the attribute is on the element, then
   test the server half by POSTing the relative filename the picker would have sent
   (`fetch` from the page keeps the real session cookie). Everything downstream of that string
   is then covered for real.

4. **`press_key` does not reach a `window` keydown listener.** MEASURED 2026-09-06 on the plan
   page: Escape via `press_key` did nothing with focus on BODY or on a button, while
   `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))` ran the
   handler correctly. The pre-existing panel-close ESC failed identically, which is how to tell
   a harness limit from a regression — always check whether the OLD behaviour on the same
   listener also fails before concluding the new code is broken. Verify window-level shortcuts
   by dispatching the event in-page.

5. **Read a column in FULL before overwriting it to force a UI state.** On 2026-09-06, injecting
   a fixture into `plan_node_messages.patch_json` to render a component was preceded by a
   `select ... | head -c 300`, which truncated the value in the terminal but not in the database
   — the original was then unrecoverable, since chat rows are deliberately excluded from the
   `.haive-data` mirror and have no other backup. Dump the whole value to a scratchpad file
   first, or pick a throwaway row. Fabricating a plausible replacement is worse than nulling
   the column: an audit trail nobody can trust is worse than one that admits it is missing.

Related: [[repo-scope-editor-browser-check]], [[haive-dev-login]].

6. **Synthetic MouseEvents do not drive an xterm selection; reach the Terminal via the React
   fiber instead.** MEASURED 2026-09-06 on the task Terminal tab: `mousedown` on `.xterm-screen`
   plus `mousemove`/`mouseup` on the document produced ZERO selection rects with tmux mouse mode
   both on AND off, so a selection-dependent control cannot be exercised that way — and the MCP
   `drag` tool needs two element uids, while the a11y tree exposes only xterm's hidden
   `Terminal input` textarea, no rows. The terminal object is on no DOM node either. What works
   is walking the React fiber from the mount div (`__reactFiber$…`, then `.return` upward) and
   scanning each fiber's `memoizedState` hook chain for a ref whose `.current` has
   `getSelection`/`selectAll` — that is the live `Terminal`, and `selectLines(n, n)` then drives
   the real selection path. Read-only, so it proves the component rather than replacing it.

7. **`list_console_messages` does not see Next.js dev React errors — read the web container log
   instead.** MEASURED 2026-09-07: a hydration mismatch that Next printed in full (component
   stack and the offending attribute) returned `<no console messages found>` from the MCP tool
   on the very same page load, because the dev overlay intercepts React's `console.error`.
   `docker logs haive-web --tail 400 | grep -n "A tree hydrated"` is the reliable artefact, and
   the interleaved `GET /path` lines let a fix be proven causally: navigate a distinct URL per
   arm (fix on / fix off) and check which request the error block follows. Note plain
   `docker logs haive-web` (no `--tail`) returned only 16 lines through the rtk hook while
   `--tail 400` returned the real stream — always pass `--tail` when grepping this log.

8. **Drive an xterm's OSC 52 clipboard path with `term.write`, and stub the clipboard rather
   than writing to it.** MEASURED 2026-09-07 verifying the terminal Copy-from-CLI chip:
   `term.write('\x1b]52;c;' + btoa('PROBE') + '\x07')` on the fiber-recovered Terminal (item 6)
   drives `ClipboardAddon` → the provider exactly as a CLI would, and is LOCAL to xterm — it
   never reaches the pty, so a live tmux session is untouched. To reproduce Firefox's refusal in
   Chrome, replace `navigator.clipboard.writeText` with one that rejects `NotAllowedError`.
   Two traps: `navigator.clipboard.readText()` in an MCP `evaluate_script` HANGS on Chrome's
   permission prompt (the call is backgrounded after 120s — use `TaskStop`), so assert on page
   state instead of reading the clipboard back; and to exercise a `document.execCommand('copy')`
   path without clobbering the user's real clipboard, stub `execCommand` to return true and read
   `document.activeElement.value` to see what text it was handed. Restore every stub in the same
   script that sets it.

9. **To exercise a CLI sign-in modal without touching the user's credentials, create a
   throwaway provider with `isolateAuth: true`.** MEASURED 2026-09-12 verifying the amp login
   flow: an already-authenticated provider never shows the "Log in" button (its probe passes),
   and logging it out would destroy a real session. `POST /cli-providers` with
   `{name, label: '... (delete me)', authMode, isolateAuth: true}` — plus `cliVersion` to pin an
   OLD CLI and test the legacy arm — gets its own empty auth volume, so the sign-in starts
   unauthenticated and can never write into the real provider's store. The first login on a
   pinned old version builds its sandbox image (amp: 13s). Clean up in this order: Cancel in the
   modal (that tears the login container down), `DELETE /cli-providers/<id>`, then
   `docker volume rm haive_cli_auth_p_<id12>_<name>_0/_1` and `docker rmi` the version image —
   the volumes and image outlive the row.

10. **An expired session renders as an empty feature, not as an error.** MEASURED 2026-09-13:
    mid-verification the refresh cookie died and the plan page showed "No plan yet" with zero
    task polls — indistinguishable at a glance from a fix that had silenced the poll — while every
    call answered 401 and `POST /auth/refresh` 401'd 36 times in two minutes. Before reading a
    zero as a result, check `list_network_requests` statuses. Log back in per
    [[haive-dev-login]], without the secret in any tool argument.

11. **A dialog answered through `evaluate_script`'s `dialogAction` can stay "open" in the MCP.**
    MEASURED 2026-09-13: a Discard `confirm()` accepted that way had already run its DELETE, and
    the page kept polling and rendering for minutes — impossible under a blocking dialog — yet the
    next `navigate_page` reported it open and demanded `handle_dialog`. Answer such a report with
    `dismiss`: if an unexpected dialog really is showing, `accept` is the choice that runs the
    destructive action (item 1).

12. **A "row" that looks like a button often is not one — HTML forbids nested `<button>`, so the
    browser RE-PARENTS the action buttons out of it.** MEASURED 2026-09-14 on
    `/settings/global-kb`: the entries list renders each row as a `div` carrying the onClick while
    the a11y snapshot still reports it as `button "<title> … archived … Reactivate Delete …"`. So
    `querySelectorAll('button').find(b => b.textContent.includes('Reactivate'))` did NOT return the
    row — it returned the standalone Reactivate button, and `.click()` REACTIVATED the user's
    archived entry (which then embedded 6 vector chunks and cleared `superseded_at`). This is item
    1's trap wearing a disguise: the text was scoped to one row, and the row still was not the
    element that matched.

    Two rules. Never pick a click target by text that an ACTION inside it also carries — match the
    row by its TITLE only, or take a snapshot and click the row's own uid with the MCP `click`
    tool. And before clicking anything on a row that owns a destructive or state-changing action,
    know what that action would do, because a mis-aimed synthetic click fires it silently with no
    confirm.

    Restoring one is only partly possible: `PATCH {status:'archived'}` puts the row back and its
    sync deletes the chunks, but the API cannot set `superseded_at` (only the activate-supersede
    path does), and `updated_at` is overwritten with no way to recover the original. Read the full
    row into a scratchpad file BEFORE any click that could mutate it — item 5's rule applies to
    clicks, not just to SQL.

13. **The MCP `click` tool clicks at COORDINATES, and the task page's "waiting for your input"
    toasts sit over the panels.** MEASURED 2026-09-24: clicking an attachment row's Remove by uid
    landed on a toast and navigated to another task (harmless there — a toast click only opens its
    task — but the same overlay could swallow a click meant for a destructive control). With parked
    tasks on the install, fire the click as a DOM `click()` on the snapshot element instead:
    `evaluate_script` with `args: [uid]`, guarded inside on the element's text and its row, and wrap
    `window.confirm` in the same script to record the message while still calling the native one
    (`dialogAction: 'accept'`). The MCP then reports the accepted dialog as still open (item 11) —
    answer `dismiss`. Do not dismiss the toasts to clear the way: they are the user's reminders.

14. **An overflow probe that filters on `overflow-x != visible` misses the common case.** MEASURED
    2026-09-26 on the repos-page upgrade banner at 375 px: a non-wrapping flex row made the whole
    card wider than the screen, `main` (not the document) scrolled sideways, and a probe counting
    only elements with `scrollWidth > clientWidth` AND a non-visible `overflow-x` reported 0 while
    the row's button sat at 481 px. `document.documentElement.scrollWidth` also stayed at 375,
    because `main` is the scroll container. Measure what a person sees instead: every action's
    `getBoundingClientRect().right <= innerWidth`, and `main.scrollWidth <= main.clientWidth`.
