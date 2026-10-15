// Runs INSIDE a production image, from the host package's directory (so @haive/shared resolves):
//   docker run --rm -i -w /app/packages/api -e CHECK_FILE=/app/packages/api/dist/modules.generated.js \
//     -e CHECK_PACKAGE=@haive-module/smokefix <image> node --input-type=module - < check-registry-list.mjs
// The generated module list is the file the api and the worker load at boot. It must name the
// package with source "registry", and each of its entries must pass what both loaders check
// before they mount anything: a valid manifest, and a package name whose id is the manifest's id.
import { pathToFileURL } from 'node:url';

const file = process.env.CHECK_FILE;
const wanted = process.env.CHECK_PACKAGE;
const { moduleRegistry } = await import(pathToFileURL(file).href);
const { moduleManifestSchema, modulePackageId } = await import('@haive/shared/modularity');

const problems = [];
for (const entry of moduleRegistry) {
  const parsed = moduleManifestSchema.safeParse(entry.manifest);
  if (!parsed.success) {
    problems.push(`${entry.packageName}: invalid manifest`);
  } else if (modulePackageId(entry.packageName) !== parsed.data.id) {
    problems.push(`${entry.packageName}: declares id "${parsed.data.id}"`);
  }
}
const names = moduleRegistry.map((entry) => `${entry.packageName} (${entry.source})`);
const listed = moduleRegistry.find((entry) => entry.packageName === wanted);
if (listed === undefined) {
  problems.push(`${wanted} is not in the list`);
} else if (listed.source !== 'registry') {
  problems.push(`${wanted} is listed with source "${listed.source}", not "registry"`);
}
console.log(`${file}: ${names.join(', ')}`);
for (const problem of problems) console.error(`problem: ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
