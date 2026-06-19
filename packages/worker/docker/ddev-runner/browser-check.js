// Headless-Chrome validation of a running app, executed INSIDE the DDEV runner
// (where the project's <name>.ddev.site URL resolves). Prints a JSON report of
// console/network errors. Invoked by 08a-browser-verify via `node
// /opt/browser-check.js <url>`. puppeteer-core + chromium are baked into the
// runner image; --ignore-certificate-errors covers DDEV's local mkcert TLS.
const puppeteer = require('puppeteer-core');

async function run() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node browser-check.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
    ],
  });

  const page = await browser.newPage();
  const consoleMessages = [];
  const networkErrors = [];

  page.on('console', (msg) => {
    consoleMessages.push({ level: msg.type(), text: msg.text() });
  });
  page.on('requestfailed', (req) => {
    networkErrors.push(req.url() + ' ' + (req.failure()?.errorText || 'unknown'));
  });

  let httpStatus = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    httpStatus = resp ? resp.status() : null;
  } catch (err) {
    consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message });
  }

  const title = await page.title().catch(() => null);
  await browser.close();

  const errors = consoleMessages.filter((m) => m.level === 'error').map((m) => m.text);
  const warnings = consoleMessages.filter((m) => m.level === 'warning').map((m) => m.text);
  // Only 5xx (server crash, e.g. PHP memory exhaustion) is a hard fail; 4xx like
  // 401/403/404 are legitimate for login-gated apps and must not fail the check.
  const httpBad = httpStatus !== null && httpStatus >= 500;

  console.log(
    JSON.stringify({
      pageTitle: title,
      httpStatus: httpStatus,
      consoleErrors: errors.slice(0, 50),
      consoleWarnings: warnings.slice(0, 50),
      networkErrors: networkErrors.slice(0, 50),
      passed: errors.length === 0 && networkErrors.length === 0 && !httpBad,
    }),
  );
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
