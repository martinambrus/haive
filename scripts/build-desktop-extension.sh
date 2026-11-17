#!/bin/sh
# Build only the extension; never start a stack, install it, or push an image.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/hde-build.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$scratch/bridge" "$scratch/ui" "$scratch/install"
# Explicit allowlist: no checkout .env, .npmrc, node_modules or other secrets.
cp "$root/docker/desktop-extension/Dockerfile" "$root/docker/desktop-extension/metadata.json" "$scratch/"
cp "$root/packages/web/src/app/icon.svg" "$scratch/icon.svg"
cp "$root/docker/desktop-extension/bridge/"*.go "$root/docker/desktop-extension/bridge/go.mod" "$scratch/bridge/"
for file in package.json package-lock.json app.js controller.js index.html style.css; do
  cp "$root/docker/desktop-extension/ui/$file" "$scratch/ui/"
done
cp "$root/install/install.sh" "$root/install/install.ps1" "$scratch/install/"
docker buildx build --platform linux/amd64,linux/arm64 --load \
  --tag haive-desktop-extension:dev --tag haive-desktop-extension:0.0.0-dev "$scratch"
# Schema validation works offline against the local metadata. SDK v0.2.32's
# full image validator additionally requires a semver tag and checks availability
# in DockerHub, even when both architectures are loaded locally. Never push here.
docker extension validate "$scratch/metadata.json"
printf '%s\n' 'Built haive-desktop-extension:dev (also tagged 0.0.0-dev); metadata validation passed.'
printf '%s\n' 'Full image validation is separate: docker extension validate --sdk-compatibility haive-desktop-extension:0.0.0-dev'
