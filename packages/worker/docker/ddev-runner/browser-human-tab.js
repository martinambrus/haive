// Which tab of the runner's headed browser is the HUMAN's -- the one the VNC panel
// shows and the one browser-close-extra-tabs.js must never close.
//
// WHY THIS IS RECORDED AND NOT DERIVED. It used to be derived, from
// `document.visibilityState === 'visible'`, on the reasoning that a headed browser has
// exactly one tab on screen. That reasoning is right and the signal is wrong: MEASURED
// on a live runner with two agent tabs in ONE window (identical `windowId` and identical
// window bounds), BOTH tabs reported `visibilityState: 'visible'`, `document.hidden:
// false`, `document.hasFocus(): true`, animation frames, and screencast frames. So the
// sweep found two "visible" tabs, refused to act (it fails safe) and closed nothing --
// i.e. the leak it exists to stop went unswept on exactly the multi-tab runners that
// leak. The likely cause is the desktop's three anti-backgrounding switches
// (--disable-renderer-backgrounding and friends in start-browser-desktop.sh), which were
// added in the same change that gave every agent its own tab; whatever the cause, no
// page-side signal separates the tabs any more.
//
// The one thing that is not a guess is who PUT the human on that tab: this codebase did.
// browser-probe-connect.js and browser-login.js each pick a tab and call
// `bringToFront()`, so after either of them runs, the tab they picked IS the tab on
// screen. Recording its CDP target id there turns "which tab is on screen" from an
// inference into a fact. The id comes from `Target.getTargetInfo`, part of the CDP
// contract, rather than from puppeteer's private `_targetId`.
//
// FAILS SAFE IN BOTH DIRECTIONS. A missing, empty or stale record means the sweep closes
// NOTHING (see browser-close-extra-tabs.js) -- a leaked tab costs memory, closing the tab
// someone is working in costs their work. And recording is best-effort: a browser bring-up
// or an app login must not fail because a bookkeeping file could not be written.
//
// UIDS. The writers run as `ddev` on the DDEV runner (runnerExec passes `docker exec -u
// ddev`) and as root on the app-runner, while the sweep always runs as root -- reading is
// therefore never a problem. Rewriting across a uid change is: /tmp is world-writable and
// sticky, and `fs.protected_regular` is 2 in these containers (MEASURED), so even root
// cannot O_CREAT over a file owned by another user there. Hence unlink-then-write, which
// covers the reachable direction (root replacing a `ddev` file); the reverse leaves a
// record that no longer matches any open tab, which the sweep treats as "close nothing".
const fs = require('fs');

const HUMAN_TAB_FILE = '/tmp/haive-human-tab';

/** CDP target id of a puppeteer page, or null. */
async function targetIdOf(page) {
  let session;
  try {
    session = await page.createCDPSession();
    const info = await session.send('Target.getTargetInfo');
    return info && info.targetInfo ? info.targetInfo.targetId : null;
  } catch {
    return null;
  } finally {
    if (session) {
      try {
        await session.detach();
      } catch {
        // ignored: the target may already be gone
      }
    }
  }
}

/** Record `page` as the human's tab. Best-effort, never throws. */
async function recordHumanTab(page) {
  const id = await targetIdOf(page);
  if (!id) return null;
  try {
    fs.unlinkSync(HUMAN_TAB_FILE);
  } catch {
    // ignored: no previous record, or one this uid may not remove
  }
  try {
    fs.writeFileSync(HUMAN_TAB_FILE, id, 'utf8');
    return id;
  } catch {
    return null;
  }
}

/** The recorded human tab id, or null when nothing was recorded. */
function readHumanTabId() {
  try {
    const raw = fs.readFileSync(HUMAN_TAB_FILE, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

module.exports = { HUMAN_TAB_FILE, targetIdOf, recordHumanTab, readHumanTabId };
