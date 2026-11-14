// Turbo reads package.json rather than pnpm readPackage hooks. Build the private
// workspace closure first, and bypass host caches while a local selection exists.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import local from './local-modules.cjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [task] = process.argv.slice(2);
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
run(['exec', 'turbo', 'run', task, ...(local.localMode() ? ['--force'] : [])]);
