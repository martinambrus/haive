// Closes every tab of the runner's headed browser except the first one, and
// disconnects without touching the browser itself.
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
// KEEPING THE FIRST PAGE is the same convention browser-probe-connect.js and
// browser-login.js already follow: they reuse pages[0] and bringToFront() it so the
// human's VNC panel lands on the app.
//
// Ordering therefore has to come from puppeteer, not from the CDP /json/list HTTP
// endpoint. They are NOT the same order: MEASURED on a live runner holding two tabs,
// puppeteer returned [init.php, index.php?lang=en] and /json/list returned exactly the
// reverse. Rewriting this over /json/list would keep whichever tab happened to be
// active and close the human's.
const puppeteer = require('puppeteer-core');

async function run() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let closed = 0;
  for (const page of pages.slice(1)) {
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

  console.log(JSON.stringify({ kept: pages.length > 0 ? 1 : 0, closed }));
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
