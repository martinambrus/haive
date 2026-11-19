#!/bin/sh
# Bakes the git MCP server into an image so it starts with no network: a uv-managed CPython 3.13
# and a venv holding mcp-server-git and its dependencies, installed from the hashed lock beside
# this script into /opt/haive-git-mcp-<version>. Runs as root at image build time and is a
# no-op when that tree was built from this lock and this script.
set -eu
umask 022

here="$(cd "$(dirname "$0")" && pwd)"
lock="$here/git-mcp-requirements.txt"
# The toolchain is pinned with the lock: this uv, not the image's own (old on some Alpine
# releases, absent on bespoke bases), fetches this CPython.
uv_version="0.12.5"
python_version="3.13.15"

version="$(sed -n 's/^mcp-server-git==\([^[:space:];\\]*\).*/\1/p' "$lock")"
case "$version" in
  '' | *[!0-9A-Za-z._+-]*)
    echo "haive: $lock does not pin mcp-server-git" >&2
    exit 1
    ;;
esac
root="/opt/haive-git-mcp-$version"
# Everything that decides the tree: the hashed lock, and the script that carries the uv and
# CPython pins.
stamp="$(cat "$lock" "$0" | sha256sum | cut -d' ' -f1)"

if [ "$(cat "$root/install.sha256" 2>/dev/null || true)" = "$stamp" ]; then
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "haive: curl is required to bake the git MCP server and was not found" >&2
  exit 1
fi

# uv's own release tarball, checked against the sha256 astral publishes beside it, rather than its
# installer script, which nothing would check. uv in turn checks the CPython it downloads against
# the hashes built into it, and the lock carries a hash for every wheel.
arch="$(uname -m)"
libc=gnu
if [ -e "/lib/ld-musl-$arch.so.1" ]; then libc=musl; fi
case "$arch-$libc" in
  x86_64-gnu) uv_sha256=68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2 ;;
  aarch64-gnu) uv_sha256=9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31 ;;
  x86_64-musl) uv_sha256=a4742988791c9aeae68c78150d6cba762062ad2a47e53738c2779d2b596bfcdb ;;
  aarch64-musl) uv_sha256=8767a0e77f2cd45436401b1b42bf7e9ed5a4a91a74a5305d6fe93249d0f6dbc5 ;;
  *)
    echo "haive: no pinned uv build for $arch-$libc" >&2
    exit 1
    ;;
esac
uv_target="uv-$arch-unknown-linux-$libc"

tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT
curl -fsSL -o "$tools/uv.tar.gz" "https://github.com/astral-sh/uv/releases/download/$uv_version/$uv_target.tar.gz"
if [ "$(sha256sum "$tools/uv.tar.gz" | cut -d' ' -f1)" != "$uv_sha256" ]; then
  echo "haive: $uv_target.tar.gz does not match its pinned sha256" >&2
  exit 1
fi
tar -xzf "$tools/uv.tar.gz" -C "$tools"
uv="$tools/$uv_target/uv"

rm -rf "$root"
mkdir -p "$root"
# Only the interpreter uv downloads into the tree (never the image's own python) and no cache.
export UV_PYTHON_INSTALL_DIR="$root/python" UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_DOWNLOADS=automatic UV_NO_CACHE=1
"$uv" venv --python "$python_version" "$root/venv"
"$uv" pip install --python "$root/venv/bin/python" --only-binary :all: --require-hashes --compile-bytecode -r "$lock"
# GitPython refuses to import without a git executable; this checks the tree, not the base's git.
env GIT_PYTHON_REFRESH=quiet "$root/venv/bin/python" -I -c "import mcp_server_git"
# uv leaves two empty lock files writable by everyone; nothing here may be changed by the sandbox user.
chmod -R go-w "$root"
# Written last: a half-installed tree is never trusted.
echo "$stamp" > "$root/install.sha256"
