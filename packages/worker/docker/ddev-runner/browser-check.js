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

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message });
  }

  const title = await page.title().catch(() => null);
  await browser.close();

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
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
