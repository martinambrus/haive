// Closes every tab of the runner's headed browser except the one currently on screen,
// and disconnects without touching the browser itself.
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
// WHICH TAB SURVIVES, and why it is not "the first one". Neither list order is a
// contract, and both were MEASURED lying on a live runner:
//   - puppeteer's browser.pages() is NOT creation order. Two probes minutes apart
//     disagreed: one run put the newest tab at index 0, the next put the oldest there.
//     An early version of this script kept pages[0] and closed the app tab the human
//     was looking at.
//   - CDP /json/list is a different order again (it looked most-recently-active first),
//     so swapping one for the other only changes which way it is wrong.
// document.visibilityState does answer exactly the question that matters: in a headed
// browser precisely one tab is on screen, and that is the one the VNC panel shows.
// Measured on three tabs: one 'visible' with document.hasFocus(), two 'hidden'.
//
// FAILS SAFE. If the visible tab cannot be identified -- zero or several report
// 'visible', every evaluate times out on a wedged renderer -- nothing is closed. A
// leaked tab costs memory; closing the tab someone is working in costs their work.
const puppeteer = require('puppeteer-core');

// A tab whose renderer is wedged never answers. Bound it so one bad tab cannot hold
// the whole sweep open until the caller's docker-exec timeout kills it.
const VISIBILITY_TIMEOUT_MS = 3000;

async function visibilityState(page) {
  try {
    return await Promise.race([
      page.evaluate(() => document.visibilityState),
      new Promise((resolve) => setTimeout(() => resolve(null), VISIBILITY_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

async function run() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const states = await Promise.all(pages.map(visibilityState));
  const visible = pages.filter((_, i) => states[i] === 'visible');

  if (visible.length !== 1) {
    await browser.disconnect();
    console.log(
      JSON.stringify({
        kept: pages.length,
        closed: 0,
        reason: `expected exactly one visible tab, found ${visible.length}`,
      }),
    );
    return;
  }

  const keep = visible[0];
  let closed = 0;
  for (const page of pages) {
    if (page === keep) continue;
    // One tab refusing to close (a beforeunload dialog, a target that died mid-list)
    // must not strand the rest.
    try {
      await page.close();
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
