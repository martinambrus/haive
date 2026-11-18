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

tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT
curl -fsSL -o "$tools/install.sh" "https://astral.sh/uv/$uv_version/install.sh"
env UV_UNMANAGED_INSTALL="$tools" sh "$tools/install.sh"
uv="$tools/uv"

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
