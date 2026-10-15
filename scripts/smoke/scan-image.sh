#!/usr/bin/env bash
# Counts how often $SCAN_TOKEN occurs in an image, in the places an image keeps a build's values:
# `docker history --no-trunc`, `docker image inspect` (Env, Labels, everything), and every file of
# `docker save`: the manifests and the config, and each layer read through tar so the bytes are
# the ones in the layer (a deleted file still counts: its layer still holds it).
#
#   SCAN_TOKEN=<token> scripts/smoke/scan-image.sh <image>
#
# Prints `history=<n> inspect=<n> config=<n> layers=<n> tars=<n>` (tars: how many layer tars were
# read). Exit 0 when the four counts are 0, 1 when any is not, 2 when the scan itself could not
# run, or read no layer at all (an exit 0 never means "could not look").
set -uo pipefail

image=${1:-}
if [[ -z "$image" || -z "${SCAN_TOKEN:-}" ]]; then
  echo "usage: SCAN_TOKEN=<token> scan-image.sh <image>" >&2
  exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
count() { node "$here/count-token.mjs"; }
unreadable() {
  echo "scan-image: cannot read $1" >&2
  exit 2
}

history=$(docker history --no-trunc "$image" | count) || unreadable "the history of $image"
inspect=$(docker image inspect "$image" | count) || unreadable "the inspect output of $image"

work=$(mktemp -d "${TMPDIR:-/tmp}/scan-image.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT
docker save "$image" | tar -x -C "$work" || unreadable "docker save of $image"

config=0
layers=0
tars=0
while IFS= read -r -d '' blob; do
  listing=$(tar -tf "$blob" 2>/dev/null | head -n 1)
  if [[ -n "$listing" ]] || tar -tf "$blob" >/dev/null 2>&1; then
    n=$(tar -xOf "$blob" | count) || unreadable "a layer of $image ($(basename "$blob"))"
    layers=$((layers + n))
    tars=$((tars + 1))
  else
    case $(head -c 4 "$blob" | od -An -tx1 | tr -d ' \n') in
      1f8b* | 28b52ffd | fd377a58 | 425a68*) unreadable "a compressed file that tar cannot list ($(basename "$blob"))" ;;
    esac
    n=$(count <"$blob") || unreadable "a file of docker save of $image ($(basename "$blob"))"
    config=$((config + n))
  fi
done < <(find "$work" -type f -print0)
[[ $tars -gt 0 ]] || unreadable "any layer of $image: docker save held no tar"

echo "history=$history inspect=$inspect config=$config layers=$layers tars=$tars"
[[ $((history + inspect + config + layers)) -eq 0 ]]
