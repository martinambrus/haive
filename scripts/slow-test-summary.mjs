import { globSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cell = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replace(/[\r\n]/g, ' ');

export function renderSlowTests(reports, root = process.cwd()) {
  const files = reports
    .flatMap((report) => report.testResults ?? [])
    .filter(
      (file) =>
        typeof file.name === 'string' &&
        Number.isFinite(file.startTime) &&
        Number.isFinite(file.endTime) &&
        file.startTime > 0 &&
        file.endTime >= file.startTime,
    )
    .map((file) => ({
      name: isAbsolute(file.name) ? relative(root, file.name) : file.name,
      seconds: (file.endTime - file.startTime) / 1000,
    }))
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
    .slice(0, 15);
  const title = '### Slowest test files (report only)\n\n';
  if (!files.length) return title + 'No test file timings were available.\n';
  return (
    title +
    '| Test file | Wall time (s) |\n| --- | ---: |\n' +
    files.map((file) => `| ${cell(file.name)} | ${file.seconds.toFixed(3)} |`).join('\n') +
    '\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reports = [];
  // The report path is relative to each package's cwd, so parallel package runs cannot overwrite it.
  // Discover reports rather than maintaining a second list of workspace packages.
  for (const file of globSync('**/.turbo/unit-tests.json', {
    exclude: ['**/node_modules/**', '**/.git/**'],
  })) {
    try {
      const report = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(report?.testResults)) throw new Error('missing testResults array');
      reports.push(report);
    } catch (error) {
      // Reporting is informational, including when a failed test runner left an incomplete file.
      process.stderr.write(`Could not read ${file}: ${error.message}\n`);
    }
  }
  process.stdout.write(renderSlowTests(reports));
}
