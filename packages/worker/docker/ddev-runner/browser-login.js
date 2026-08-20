// Log the runner's HEADED browser into the app under test, so later agent and
// human sessions start authenticated. Connects to the desktop's existing Chromium
// over CDP (like browser-probe-connect.js), performs a form login, verifies it,
// and DISCONNECTS without closing — the cookie jar lives in that browser's
// persistent --user-data-dir, so every later chrome-devtools session inherits it.
//
// Credentials arrive as environment variables, never as arguments: argv is visible
// to anything that can read /proc on the runner, and this script is invoked through
// a shell command string. They are also never passed to a model — the whole reason
// the login is done here in deterministic code rather than by an agent.
//
// Invoked by 08a-browser-verify via `node /opt/browser-login.js <config-json>`.
// Prints one JSON line: { ok, reason, url, title }.
const puppeteer = require('puppeteer-core');

const NAV_TIMEOUT_MS = 30000;
const SELECTOR_TIMEOUT_MS = 15000;

function fail(reason) {
  console.log(JSON.stringify({ ok: false, reason, url: null, title: null }));
  process.exit(0); // a failed login is a reported outcome, not a crashed script
}

async function run() {
  const rawConfig = process.argv[2];
  if (!rawConfig) {
    console.error('usage: node browser-login.js <config-json>');
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(rawConfig);
  } catch (err) {
    fail('login config was not valid JSON: ' + err.message);
    return;
  }

  const username = process.env.HAIVE_APP_USERNAME || '';
  const password = process.env.HAIVE_APP_PASSWORD || '';
  if (!username || !password) {
    fail('no app credentials were provided to the runner');
    return;
  }
  if (!cfg.loginUrl || !cfg.usernameSelector || !cfg.passwordSelector || !cfg.submitSelector) {
    fail('login config is incomplete (needs loginUrl and the three selectors)');
    return;
  }

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  try {
    // Reuse the visible tab, exactly as browser-probe-connect does, so the user
    // watching the VNC panel sees the login happen rather than a blank window.
    const existing = await browser.pages();
    const page = existing.length > 0 ? existing[0] : await browser.newPage();
    await page.bringToFront().catch(() => {});

    await page.goto(cfg.loginUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

    await page.waitForSelector(cfg.usernameSelector, { timeout: SELECTOR_TIMEOUT_MS });
    await page.type(cfg.usernameSelector, username, { delay: 10 });
    await page.waitForSelector(cfg.passwordSelector, { timeout: SELECTOR_TIMEOUT_MS });
    await page.type(cfg.passwordSelector, password, { delay: 10 });

    // Some apps navigate on submit, some resolve in place (SPA). Race the
    // navigation against the click so neither shape hangs the login.
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
        .catch(() => {}),
      page.click(cfg.submitSelector),
    ]);

    const condition = cfg.successCondition || {};
    let ok = false;
    let reason = '';
    if (condition.type === 'url_contains') {
      ok = page.url().includes(String(condition.value ?? ''));
      reason = ok ? '' : `url ${page.url()} does not contain ${condition.value}`;
    } else if (condition.type === 'element_present') {
      const found = await page
        .waitForSelector(String(condition.value ?? ''), { timeout: SELECTOR_TIMEOUT_MS })
        .catch(() => null);
      ok = Boolean(found);
      reason = ok ? '' : `element ${condition.value} not present after submit`;
    } else {
      // No condition means we cannot tell a successful login from a re-rendered
      // login form, and reporting an unverified login as success is the one
      // outcome that would make the tester trust a session it does not have.
      reason = 'no successCondition configured, so the login could not be verified';
    }

    const title = await page.title().catch(() => null);
    console.log(JSON.stringify({ ok, reason, url: page.url(), title }));
  } catch (err) {
    fail(err.message);
    return;
  } finally {
    // Leave the browser and its session open; detach only our CDP client.
    await browser.disconnect().catch(() => {});
  }
}

run().catch((err) => {
  fail(err.message);
});
