// Headless-style validation probe against the HEADED browser of the runner's
// desktop (started by start-browser-desktop.sh): connects to the local CDP
// endpoint, opens a tab, navigates, collects console/network errors + title,
// prints the same JSON report as browser-check.js — and then DISCONNECTS
// without closing the browser, so the user keeps the live session in the VNC
// panel. Invoked by 08a-browser-verify (interactive mode) via
// `node /opt/browser-probe-connect.js <url>`.
const puppeteer = require('puppeteer-core');

async function run() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node browser-probe-connect.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  // Reuse the desktop's existing (about:blank) tab so the user lands ON the app
  // in the VISIBLE window. browser.newPage() would navigate a background tab and
  // leave about:blank in front. bringToFront foregrounds it; we leave it open.
  const existingPages = await browser.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await browser.newPage();
  await page.bringToFront().catch(() => {});
  const consoleMessages = [];
  const networkErrors = [];

  page.on('console', (msg) => {
    consoleMessages.push({ level: msg.type(), text: msg.text() });
  });
  page.on('requestfailed', (req) => {
    networkErrors.push(req.url() + ' ' + (req.failure()?.errorText || 'unknown'));
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message });
  }

  const title = await page.title().catch(() => null);

  const errors = consoleMessages.filter((m) => m.level === 'error').map((m) => m.text);
  const warnings = consoleMessages.filter((m) => m.level === 'warning').map((m) => m.text);

  console.log(
    JSON.stringify({
      pageTitle: title,
      consoleErrors: errors.slice(0, 50),
      consoleWarnings: warnings.slice(0, 50),
      networkErrors: networkErrors.slice(0, 50),
      passed: errors.length === 0 && networkErrors.length === 0,
    }),
  );

  // Leave the page open for the user; just detach our CDP session.
  await browser.disconnect();
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
