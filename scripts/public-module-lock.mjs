// Public module edits must update the release lock even while local clones exist.
// Resolve a manifest-only public workspace in scratch, then refresh the local lock.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
export function publicModuleLock(root) {
  const scratch = mkdtempSync(join(tmpdir(), 'haive-public-lock-'));
  try {
    const copy = (rel) => {
      if (!existsSync(join(root, rel))) return;
      mkdirSync(dirname(join(scratch, rel)), { recursive: true });
      copyFileSync(join(root, rel), join(scratch, rel));
    };
    for (const file of [
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      '.pnpmfile.cjs',
      '.npmrc',
      'scripts/local-modules.cjs',
    ])
      copy(file);
    for (const parent of ['packages', 'modules']) {
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) copy(`${parent}/${entry.name}/package.json`);
      }
    }
    const result = spawnSync('pnpm', ['install', '--lockfile-only'], {
      cwd: scratch,
      stdio: 'inherit',
    });
    if (result.status === 0)
      copyFileSync(join(scratch, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'));
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
