// Puts the runner's headed browser window back to the full desktop after an agent
// shrank it, and disconnects without touching anything else.
//
// WHY. chrome-devtools-mcp's `resize_page` is not viewport emulation. MEASURED in the
// shipped 1.7.0 bundle (build/src/tools/pages.js): it takes the window out of
// fullscreen/maximized via `Browser.setWindowBounds`, then calls puppeteer's
// `page.resize()`, which moves the real window so that its CONTENT area matches the
// requested size. The change therefore outlives the MCP session that made it -- measured
// across three live runners, every one sat at 1280x887 on a 1920x1080 screen, content
// exactly the 1280x800 that 08a's screenshot protocol asks for -- and the human who opens
// the Gate 2 VNC panel gets a small window instead of the desktop they had.
//
// WHY NOT ASK THE AGENT TO UNDO IT. Two reasons, both measured. `resize_page` is the only
// sizing tool an agent has and its arguments are CONTENT size, so asking for the screen
// size overshoots the window past the bottom of the display; there is no tool at all for
// window state or position. And every agent of a task works in a tab of the SAME window
// (measured: two agent tabs, one `windowId`, one set of bounds), so an agent restoring at
// the end of its own run would resize a sibling's viewport mid-screenshot -- the class of
// stomping BROWSER_TAB_DISCIPLINE exists to prevent. Window size is a barrier concern.
//
// WHAT IT RESTORES TO. The origin of the Xvfb screen, at exactly the screen's size, read
// from the page (`screen.width/height`) rather than from the 1920x1080 literal in
// start-browser-desktop.sh so the two cannot drift. That is the invariant the human cares
// about -- the browser fills the desktop the VNC panel shows -- and deliberately NOT the
// launch geometry: Chrome places the window at a 10,10 offset, so replaying the launch
// size would hang 20px off the right and bottom edges.
//
// Every distinct window is restored rather than the first one found, because nothing stops
// a tool from opening a second browser window, and a window already filling the screen is
// left alone so a repeat call writes nothing.
//
// BEST EFFORT, like browser-close-extra-tabs.js: a window that will not move is not a
// reason to fail the step that called this.
const puppeteer = require('puppeteer-core');

// A wedged renderer never answers `screen.width`. Bound it so one bad tab cannot hold the
// whole restore open until the caller's docker-exec timeout kills it.
const METRICS_TIMEOUT_MS = 3000;

// Chrome does not always land on the bounds it was given: MEASURED on this desktop, a
// 1920x1080 request at 0,0 settles at 1919x1079, and asking again does not change it. So
// the skip test asks whether the window already COVERS the screen rather than whether it
// matches it exactly -- with an exact test the window is never "already full" and every
// barrier rewrites identical bounds and reports a restore that did nothing.
const COVERAGE_SLACK_PX = 2;

async function screenSize(page) {
  try {
    return await Promise.race([
      page.evaluate(() => ({ w: window.screen.width, h: window.screen.height })),
      new Promise((resolve) => setTimeout(() => resolve(null), METRICS_TIMEOUT_MS)),
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
  const seen = new Set();
  let restored = 0;
  let alreadyFull = 0;
  let failed = 0;

  for (const page of pages) {
    let windowId;
    try {
      windowId = await page.windowId();
    } catch {
      failed += 1;
      continue;
    }
    if (seen.has(windowId)) continue;
    seen.add(windowId);

    const screen = await screenSize(page);
    if (!screen || !screen.w || !screen.h) {
      failed += 1;
      continue;
    }

    try {
      const bounds = await browser.getWindowBounds(windowId);
      if (
        bounds.windowState === 'normal' &&
        bounds.left <= 0 &&
        bounds.top <= 0 &&
        bounds.left + bounds.width >= screen.w - COVERAGE_SLACK_PX &&
        bounds.top + bounds.height >= screen.h - COVERAGE_SLACK_PX
      ) {
        alreadyFull += 1;
        continue;
      }
      // Geometry can only be set on a 'normal' window. The double call for fullscreen is
      // upstream's measured X11 workaround (chrome-devtools-mcp resize_page does the same);
      // this desktop is the same environment, so it is kept rather than trimmed.
      if (bounds.windowState === 'fullscreen') {
        await browser.setWindowBounds(windowId, { windowState: 'normal' });
        await browser.setWindowBounds(windowId, { windowState: 'normal' });
      } else if (bounds.windowState !== 'normal') {
        await browser.setWindowBounds(windowId, { windowState: 'normal' });
      }
      await browser.setWindowBounds(windowId, {
        left: 0,
        top: 0,
        width: screen.w,
        height: screen.h,
      });
      restored += 1;
    } catch {
      failed += 1;
    }
  }

  // Detach only. The browser is the user's live session and the next step's agents.
  await browser.disconnect();

  console.log(JSON.stringify({ windows: seen.size, restored, alreadyFull, failed }));
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
