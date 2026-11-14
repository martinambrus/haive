#!/usr/bin/env node
// Emit the release manifest for a tag.
//
// Run by the release workflow after the images are pushed, so it can be handed their digests:
//
//   node scripts/build-release-manifest.mjs --version v0.2.0 \
//     --api sha256:… --worker sha256:… --web sha256:… > release.json
//
// Opt in with --bundle-dir <tree>: read compose files and install/bundle-env.json from that
// directory, and unique bundle records from v* tags merged into the invoking checkout's HEAD.
// The target requires base and run compose files; overlays and historical files may be absent.
// RC tags remain eligible so pristine RC installs can be recognised, and the target is excluded.
// Shallow checkouts always fail. A tagless first release must explicitly pass --allow-no-history;
// otherwise missing release tags or a git read failure aborts with stderr and no manifest output.
// An archived bundle tree need not carry .git; the generator's own tree must carry the shared
// manifest schema and its dependencies. Without --bundle-dir, only the migrations are needed.
//
// Everything else is derived from the tree, so a release cannot forget to update it:
// `migrationHead` is the highest migration the corpus ships, and `contracts` is computed from
// whether any migration after the baseline removes something.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../packages/database/migrations/', import.meta.url));
// Kept equal to RELEASE_BUNDLE_FILES by build-release-manifest.test.mjs's schema round-trip.
const BUNDLE_FILES = [
  'docker-compose.yml',
  'docker-compose.run.yml',
  'docker-compose.gpu.yml',
  'docker-compose.vulkan.yml',
];

function die(message) {
  console.error(`[release-manifest] ${message}`);
  process.exit(1);
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) die(`--${name} needs a value`);
  return value;
}

/** Strip a leading `v`, so `v0.2.0` and `0.2.0` mean the same release. */
function normalizeVersion(v) {
  return v.replace(/^v/, '');
}

const sha256 = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });

async function buildBundle(dir, version) {
  // Read only fixed names, in allowlist order. A missing overlay is legitimate; other I/O
  // failures must abort rather than publish a hash record that silently omits a file.
  const present = new Set(readdirSync(dir));
  for (const name of ['docker-compose.yml', 'docker-compose.run.yml']) {
    if (!present.has(name)) throw new Error(`target bundle is missing required file ${name}`);
  }
  const files = Object.fromEntries(
    BUNDLE_FILES.filter((name) => present.has(name)).map((name) => [
      name,
      sha256(readFileSync(join(dir, name))),
    ]),
  );
  // Load only on the bundle path: legacy channel archives contain just this script and migrations.
  const { releaseBundleEnvSchema } = await import('../packages/shared/src/release/manifest.ts');
  const env = releaseBundleEnvSchema.parse(
    JSON.parse(readFileSync(join(dir, 'install/bundle-env.json'), 'utf8')),
  );
  if (git('rev-parse', '--is-shallow-repository').toString('utf8').trim() !== 'false') {
    throw new Error('shallow checkout: fetch the full release history before building a bundle');
  }
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=refname')
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  if (tags.length === 0 && !process.argv.includes('--allow-no-history')) {
    throw new Error('no v* release tags found; use --allow-no-history only for a first release');
  }
  const known = [];
  const seen = new Set();
  for (const tag of tags) {
    if (normalizeVersion(tag) === version) continue;
    const ref = `refs/tags/${tag}`;
    // Listing the tree distinguishes absent historical files from a failed git read. Do not
    // turn every failed `git show` (including corruption) into an apparently missing file.
    const names = new Set(
      git('ls-tree', '--name-only', ref, '--', ...BUNDLE_FILES)
        .toString('utf8')
        .trim()
        .split('\n'),
    );
    const record = Object.fromEntries(
      BUNDLE_FILES.filter((name) => names.has(name)).map((name) => [
        name,
        sha256(git('show', `${ref}:${name}`)),
      ]),
    );
    const identity = JSON.stringify(record);
    if (Object.keys(record).length > 0 && !seen.has(identity)) {
      seen.add(identity);
      known.push(record);
    }
  }
  return { files, env, known };
}

const version = normalizeVersion(arg('version') ?? die('--version is required'));
if (version === '0.0.0-dev') die('refusing to publish a manifest for the dev sentinel');

// Every migration the runner would apply, in the order it applies them.
const files = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(f))
  .sort();
if (files.length === 0) die(`no migrations found in ${MIGRATIONS}`);
const migrationHead = files.at(-1).replace(/\.sql$/, '');

// Does this release remove anything? An additive-only release rolls back by re-pinning the
// previous tag and leaving the schema alone; one that CONTRACTS cannot, and the upgrade needs to
// know its snapshot is load-bearing. Conservative by construction: anything that looks like a
// removal counts, because a false "additive" is the answer that loses data.
const CONTRACTING = /\b(DROP\s+(TABLE|COLUMN|TYPE|CONSTRAINT|INDEX)|DELETE\s+FROM|TRUNCATE)\b/i;
const contracting = files
  .filter((f) => f !== '0000_baseline.sql')
  .filter((f) => {
    const body = readFileSync(`${MIGRATIONS}${f}`, 'utf8')
      // Comments carry rollback instructions, which are full of DROPs by definition. Only the
      // statements count.
      .replace(/^\s*--.*$/gm, '');
    return CONTRACTING.test(body);
  });

const manifest = {
  manifestVersion: 1,
  version,
  channel: arg('channel', 'public'),
  builtAt: new Date().toISOString(),
  // Declared, not inferred — see the schema. The default must be PERMISSIVE: `minFrom` is the
  // lowest version that may upgrade directly to this one, so defaulting it to this release would
  // mean only this release can upgrade to itself and every real upgrade is refused. A release that
  // needs a required stop passes --min-from explicitly.
  minFrom: normalizeVersion(arg('min-from', '0.0.0')),
  migrationHead,
  contracts: contracting.length > 0,
  images: Object.fromEntries(
    ['api', 'worker', 'web'].map((k) => [k, arg(k)]).filter(([, v]) => v !== undefined),
  ),
};

const bundleDir = arg('bundle-dir');
if (bundleDir !== undefined) {
  try {
    manifest.bundle = await buildBundle(bundleDir, version);
  } catch (error) {
    die(`could not build compose bundle: ${error.message}`);
  }
}

if (contracting.length > 0) {
  console.error(`[release-manifest] contracts: ${contracting.join(', ')}`);
}
console.log(JSON.stringify(manifest, null, 2));
