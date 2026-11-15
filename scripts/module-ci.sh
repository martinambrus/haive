#!/usr/bin/env bash
# Disposable checkout only. Usage: bash scripts/module-ci.sh <module-id> <haive-ref> [--check]
set -euo pipefail

fail() { printf 'module-ci: %s\n' "$*" >&2; exit 1; }
[[ $# -ge 2 && $# -le 3 ]] || fail 'expected <module-id> <haive-ref> [--check]'
module_id=$1
haive_ref=$2
[[ ${3:-} == '' || ${3:-} == --check ]] || fail 'unknown option'
# Same rule as MODULE_ID_PATTERN in @haive/shared/modularity (pinned by the control).
[[ $module_id =~ ^[a-z0-9][a-z0-9-]{0,22}$ ]] || fail 'invalid module-id: use 1-23 lowercase letters, digits or dashes, starting with a letter or digit'
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $haive_ref =~ ^[a-fA-F0-9]{40}$ ]]; then
  pinned=$(git rev-parse --verify "$haive_ref^{commit}") || fail 'haive-ref commit is unavailable'
else
  git check-ref-format "refs/tags/$haive_ref" >/dev/null || fail 'haive-ref must be a tag or full commit SHA'
  pinned=$(git rev-parse --verify "refs/tags/$haive_ref^{commit}" 2>/dev/null) || fail 'haive-ref must be an existing tag or full commit SHA; branches are refused'
fi
[[ $(git rev-parse HEAD) == "$pinned" ]] || fail 'checkout HEAD differs from haive-ref'

feature_error='haive-ref lacks the external-module dev install (#1179); choose a newer full SHA or tag (v0.2.0 is too old)'
# Check the ignored tree and the actual pnpm hook contract, rather than help text.
git check-ignore -q "external-modules/$module_id/package.json" || fail "$feature_error"
[[ -f scripts/module.mjs && -f scripts/gen-modules.mjs && -f .pnpmfile.cjs ]] || fail "$feature_error"
node --input-type=commonjs <<'NODE' || fail "$feature_error"
const assert = require('node:assert/strict');
const local = require('./scripts/local-modules.cjs');
const { hooks } = require('./.pnpmfile.cjs');
assert.equal(hooks.readPackage, local.effectivePackage);
assert.equal(hooks.updateConfig, local.updateConfig);
assert.equal(typeof local.selection, 'function');
NODE
[[ ${3:-} != --check ]] || exit 0

source="modules/$module_id"
target="external-modules/$module_id"
[[ -z $(git ls-files -- "$source" "$target") ]] || fail 'module-id collides with tracked haive files'
# checkout initially places the caller under modules/, but #1179's dev path is external-modules/.
if [[ -d $source && ! -L $source && ! -e $target ]]; then
  mkdir -p external-modules
  mv -- "$source" "$target"
fi
[[ -d $target && ! -L $target && ! -e $source ]] || fail 'expected one module checkout under modules/<id> or external-modules/<id>'

check_clean() {
  [[ -z $(git status --porcelain --untracked-files=all) ]] || fail 'haive tree is dirty; inspect git status --porcelain'
}
check_clean
# Even a failed module command must not hide a tracked-tree mutation.
trap check_clean EXIT
package_name=$(MODULE_CI_ID=$module_id node --input-type=commonjs <<'NODE'
const assert = require('node:assert/strict');
const id = process.env.MODULE_CI_ID;
const pkg = require(`./external-modules/${id}/package.json`);
assert.ok([`@haive/module-${id}`, `@haive-module/${id}`].includes(pkg.name), 'module package name must match module-id');
assert.ok(pkg.exports?.['./manifest'], 'module must export ./manifest');
for (const command of ['build', 'typecheck', 'test']) {
  assert.ok(typeof pkg.scripts?.[command] === 'string' && pkg.scripts[command].trim(), `module needs a ${command} script`);
}
process.stdout.write(pkg.name);
NODE
)
export CI=true HUSKY=0
pnpm module add "$module_id"
pnpm install --frozen-lockfile
# Build the module and its dependency closure: core packages are workspace-only, unpublished.
pnpm --filter "$package_name..." --fail-if-no-match -r build
node scripts/gen-modules.mjs
pnpm --filter "$package_name" --fail-if-no-match typecheck
pnpm --filter "$package_name" --fail-if-no-match test
check_clean
printf 'module-ci: build, typecheck and tests passed; haive tree is clean\n'
