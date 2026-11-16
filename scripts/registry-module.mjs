import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// GitHub Packages omits exports from its packument. Inspect the published archive
// when metadata is absent, without installing dependencies or running package code.
export async function registryModuleExports(spec, { command, cwd, env }) {
  const view = await command('pnpm', ['view', spec, 'exports', '--json'], { cwd, env });
  if (view.stdout.trim()) return JSON.parse(view.stdout);
  const scratch = mkdtempSync(join(tmpdir(), 'haive-registry-module-'));
  try {
    const packed = await command(
      'npm',
      ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', scratch],
      { cwd: scratch, env: { ...env, npm_config_cache: join(scratch, 'cache') } },
    );
    const files = JSON.parse(packed.stdout);
    const file = files?.length === 1 ? files[0]?.filename : undefined;
    if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.tgz'))
      throw new Error(`could not identify the packed module ${spec}`);
    const manifest = await command(
      'tar',
      ['--no-wildcards', '-xzOf', join(scratch, file), '--', 'package/package.json'],
      { cwd: scratch, env },
    );
    if (Buffer.byteLength(manifest.stdout) > 1024 * 1024)
      throw new Error(`packed module manifest exceeds 1 MiB: ${spec}`);
    const pkg = JSON.parse(manifest.stdout);
    if (`${pkg.name}@${pkg.version}` !== spec)
      throw new Error(`packed module identity differs from ${spec}`);
    return pkg.exports;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
