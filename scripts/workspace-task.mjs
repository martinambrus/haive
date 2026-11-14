// Turbo reads package.json rather than pnpm readPackage hooks. Build the private
// workspace closure first, and bypass host caches while a local selection exists.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import local from './local-modules.cjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [task, ...extra] = process.argv.slice(2);
if (!['build', 'test', 'typecheck'].includes(task)) throw new Error('invalid workspace task');
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (local.folders().length) {
  run([
    '--filter',
    '@haive/database',
    '--filter',
    '@haive/shared',
    '--filter',
    '@haive/web-kit',
    '--filter',
    './external-modules/*',
    '-r',
    'build',
  ]);
}
// --force skips reads but still writes; --no-cache also disables writes. Keep
// policy flags before task arguments, and do not repeat flags the caller supplied.
const separator = extra.indexOf('--');
const turboOptions = separator === -1 ? extra : extra.slice(0, separator);
const cacheOptions = local.localMode()
  ? ['--force', '--no-cache'].filter((flag) => !turboOptions.includes(flag))
  : [];
run(['exec', 'turbo', 'run', task, ...cacheOptions, ...extra]);
