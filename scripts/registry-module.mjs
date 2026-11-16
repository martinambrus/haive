import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const REGISTRY_MODULE_MAX_PACK_BYTES = 100 * 1024 * 1024;
export const REGISTRY_MODULE_MAX_MANIFEST_BYTES = 1024 * 1024;

// GitHub Packages omits exports from its packument. Inspect the published archive
// when metadata is absent, without installing dependencies or running package code.
export async function registryModuleExports(
  spec,
  {
    command,
    cwd,
    env,
    maxPackBytes = REGISTRY_MODULE_MAX_PACK_BYTES,
    maxManifestBytes = REGISTRY_MODULE_MAX_MANIFEST_BYTES,
    removeScratch = rmSync,
    warn = (line) => console.error(line),
  },
) {
  const view = await command('pnpm', ['view', spec, 'exports', '--json'], { cwd, env });
  if (view.stdout.trim()) return JSON.parse(view.stdout);
  const scratch = mkdtempSync(join(tmpdir(), 'haive-registry-module-'));
  try {
    const packed = await command(
      'npm',
      ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', scratch],
      // Keep the caller's project .npmrc scope mapping while writing only to scratch.
      { cwd, env: { ...env, npm_config_cache: join(scratch, 'cache') } },
    );
    const files = JSON.parse(packed.stdout);
    const file = files?.length === 1 ? files[0]?.filename : undefined;
    if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.tgz'))
      throw new Error(`could not identify the packed module ${spec}`);
    if (!Number.isSafeInteger(files[0].size) || files[0].size > maxPackBytes)
      throw new Error(`packed module exceeds size limit (${maxPackBytes} bytes): ${spec}`);
    const manifest = await command(
      'tar',
      [
        '--occurrence=1',
        '--no-wildcards',
        '-xzOf',
        join(scratch, file),
        '--',
        'package/package.json',
      ],
      { cwd: scratch, env: { PATH: env.PATH, LANG: env.LANG } },
    );
    if (Buffer.byteLength(manifest.stdout) > maxManifestBytes)
      throw new Error(`packed module manifest exceeds 1 MiB: ${spec}`);
    if (!manifest.stdout.trim())
      throw new Error(`packed module has no package/package.json: ${spec}`);
    const pkg = JSON.parse(manifest.stdout);
    if (`${pkg.name}@${pkg.version}` !== spec)
      throw new Error(`packed module identity differs from ${spec}`);
    return pkg.exports;
  } finally {
    try {
      removeScratch(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      warn(`registry-module: cleanup failed; leftover path ${scratch}`);
    }
  }
}
