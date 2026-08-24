// Closes every tab of the runner's headed browser except the human's, and disconnects
// without touching the browser itself.
//
// WHY. Every sandboxed CLI of a task attaches chrome-devtools to THIS browser over
// CDP, and each agent is told to work in a tab of its own (BROWSER_TAB_DISCIPLINE in
// sandbox/mcp-surface.ts) so concurrent agents stop stomping each other's navigation.
// An agent that finishes normally closes its tab; one killed by a soft timeout,
// preemption or the orphan sweep never gets to, and its renderer stays resident in a
// runner whose RAM is budgeted. This is the sweep for those.
//
// The caller runs it only at a step barrier, i.e. once every agent of that step has
// ended -- closing a tab an agent is still driving would be worse than leaking it.
//
// WHICH TAB SURVIVES: the one browser-probe-connect.js / browser-login.js RECORDED as the
// human's (browser-human-tab.js), which is a fact rather than an inference -- they pick a
// tab and bring it to front, so the tab they picked is the tab on screen.
//
// It is not derived from the tabs any more, and neither list order nor any page-side
// signal is usable for it. All were MEASURED lying on live runners:
//   - puppeteer's browser.pages() is NOT creation order. Two probes minutes apart
//     disagreed: one run put the newest tab at index 0, the next put the oldest there.
//     An early version of this script kept pages[0] and closed the app tab the human
//     was looking at.
//   - CDP /json/list is a different order again (it looked most-recently-active first),
//     so swapping one for the other only changes which way it is wrong.
//   - document.visibilityState, which replaced them, then failed the same way: with two
//     agent tabs in ONE window (identical windowId, identical bounds) BOTH reported
//     'visible', document.hidden false, document.hasFocus() true, animation frames and
//     screencast frames. The sweep saw two on-screen tabs, failed safe, and closed
//     nothing -- on exactly the multi-tab runners that had something to close.
//
// FAILS SAFE. No record, an unreadable one, or a recorded tab that is no longer open, and
// nothing is closed: a leaked tab costs memory, closing the tab someone is working in
// costs their work.
const puppeteer = require('puppeteer-core');
const { targetIdOf, readHumanTabId } = require('./browser-human-tab.js');

async function run() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const humanTabId = readHumanTabId();

  function bail(reason) {
    return browser.disconnect().then(() => {
      console.log(JSON.stringify({ kept: pages.length, closed: 0, reason }));
    });
  }

  if (pages.length <= 1) return bail('nothing to sweep');
  if (!humanTabId) return bail('no human tab was recorded for this browser');

  const ids = await Promise.all(pages.map(targetIdOf));
  const keepIndex = ids.indexOf(humanTabId);
  if (keepIndex === -1) {
    return bail(`recorded human tab ${humanTabId} is no longer open`);
  }

  let closed = 0;
  for (let i = 0; i < pages.length; i += 1) {
    if (i === keepIndex) continue;
    // One tab refusing to close (a beforeunload dialog, a target that died mid-list)
    // must not strand the rest.
    try {
      await pages[i].close();
      closed += 1;
    } catch {
      // ignored on purpose -- best effort, per tab
    }
  }

  // Detach only. The browser is the user's live session and the next step's agents.
  await browser.disconnect();

  console.log(JSON.stringify({ kept: 1, closed }));
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
