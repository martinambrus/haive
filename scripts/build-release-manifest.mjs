#!/usr/bin/env node
// Emit the release manifest for a tag.
//
// Run by the release workflow after the images are pushed, so it can be handed their digests:
//
//   node scripts/build-release-manifest.mjs --version v0.2.0 \
//     --api sha256:… --worker sha256:… --web sha256:… > release.json
//
// Everything else is derived from the tree, so a release cannot forget to update it:
// `migrationHead` is the highest migration the corpus ships, and `contracts` is computed from
// whether any migration after the baseline removes something.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../packages/database/migrations/', import.meta.url));

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

if (contracting.length > 0) {
  console.error(`[release-manifest] contracts: ${contracting.join(', ')}`);
}
console.log(JSON.stringify(manifest, null, 2));
