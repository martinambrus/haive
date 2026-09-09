#!/usr/bin/env sh
# What install.sh does when the boot FAILS.
#
# The success path had coverage and the failure path had none, which is the shape of the bug this
# exists for: `pull` discarded docker's exit status (a pipeline reports its LAST command's, and
# `|| true` covered the rest), so a network that gave out mid-pull produced an install directory
# that was written, complete, and not running — with nothing said about either fact. It was
# REPORTED from a macOS arm64 host, not caught here, because a path that only ever succeeds cannot
# show that its error handling is missing.
#
# `docker` and `curl` are STUBBED, so this needs no daemon, no network and no images — which is
# what lets it run in the lint job rather than behind the 15 GB pull that keeps the real installer
# out of CI. What is under test is the installer's own branching, and that is exactly what a stub
# can drive: the scenario is chosen by which command the stub fails at.
#
# NOT covered here: the health-wait timeout. Reaching it means letting the loop run its full 6
# minutes, and a test that slow would not be run. Its budget and its message are both visible in
# one place in the source; the two branches that cost a user their afternoon are these.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/../install.sh"
[ -f "$INSTALLER" ] || { echo "[boot-failures] cannot find $INSTALLER" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# The scenario knob. `pull` and `up` make that compose subcommand exit non-zero; anything else
# lets both succeed.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env sh
case " $* " in
  *" compose "*)
    case " $* " in
      *" --short "*)  echo "2.30.0"; exit 0 ;;
      *" version "*)  echo "Docker Compose version v2.30.0"; exit 0 ;;
      *" pull "*)
        if [ "${STUB_FAIL_AT:-}" = "pull" ]; then
          echo "stub: manifest for haive-api could not be fetched" >&2
          exit 18
        fi
        exit 0 ;;
      *" up "*)
        if [ "${STUB_FAIL_AT:-}" = "up" ]; then
          echo "stub: network haive_default could not be created" >&2
          exit 1
        fi
        exit 0 ;;
    esac
    exit 0 ;;
esac
# `info`, `volume ls`, `ps` — a reachable daemon owning nothing. Empty output is what makes
# existing_state() report a clean machine and the nvidia probe find no runtime.
exit 0
STUB

cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env sh
# Answers only what install.sh asks for: the release manifest (existence check), the compose
# bundle (written to the -o target), and the api health probe.
url=""; out=""; prev=""
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
case "$url" in
  *release.json)      exit 0 ;;
  *docker-compose*)   [ -n "$out" ] && printf 'services: {}\n' > "$out"; exit 0 ;;
  *"/health")         exit 0 ;;
esac
exit 0
STUB

chmod +x "$WORK/bin/docker" "$WORK/bin/curl"

failures=0
check() {
  # $1 = label, $2 = ok (0/1), $3 = detail on failure
  if [ "$2" -eq 1 ]; then
    echo "[boot-failures] ok   $1"
  else
    echo "[boot-failures] FAIL $1"
    [ -n "${3:-}" ] && printf '%s\n' "$3" | sed 's/^/                  /'
    failures=$((failures + 1))
  fi
}

contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }

# Every file the installer must have written BEFORE it tries to boot. This set is the claim the
# new error message makes — "the install is written and complete, so this is a retry" — and a
# message that said so while leaving a half-written directory would be worse than the silence it
# replaced.
assert_complete() {
  dir=$1; label=$2
  missing=""
  for f in .env docker-compose.yml docker-compose.run.yml haive uninstall.sh; do
    [ -f "$dir/$f" ] || missing="$missing $f"
  done
  check "$label: the install directory is complete" \
        "$([ -z "$missing" ] && echo 1 || echo 0)" "missing:$missing"
  check "$label: ./haive is executable" \
        "$([ -x "$dir/haive" ] && echo 1 || echo 0)"
  # Not just that .env exists. The guard above it refuses to write an install whose secrets did
  # not generate, and an empty CONFIG_ENCRYPTION_KEY is the one that matters: it is the master key
  # for everything this install later stores.
  key=$(sed -n 's/^CONFIG_ENCRYPTION_KEY=//p' "$dir/.env" 2>/dev/null | head -1)
  check "$label: .env carries a real encryption key" \
        "$([ "${#key}" -eq 64 ] && echo 1 || echo 0)" "length was ${#key}"
  # `find -perm`, not a parse of `ls -l`: the mode is what is being asserted, and reading it out
  # of a listing is both fragile and non-portable (shellcheck SC2012 says so).
  check "$label: .env is mode 600" \
        "$([ -n "$(find "$dir/.env" -perm 600 2>/dev/null)" ] && echo 1 || echo 0)"
}

run() {
  # $1 = scenario dir suffix, $2 = STUB_FAIL_AT
  dir="$WORK/install-$1"
  out=$(
    PATH="$WORK/bin:$PATH" STUB_FAIL_AT="$2" HAIVE_GPU=cpu \
      sh "$INSTALLER" --version 9.9.9 --install-id bootfail --dir "$dir" 2>&1
  ) && code=0 || code=$?
  OUT=$out
  CODE=$code
  DIR=$dir
}

echo "[boot-failures] scenario 1: the image pull fails"
run pull pull
check "pull: the installer fails" "$([ "$CODE" -ne 0 ] && echo 1 || echo 0)" "exit was $CODE"
# The regression itself. `|| true` let a failed pull fall through to `up`, which then failed for a
# reason that had nothing to do with what actually went wrong.
check "pull: it stops there and does not go on to start" \
      "$(contains "$OUT" 'Starting Haive' && echo 0 || echo 1)" "$OUT"
check "pull: the message names the retry command" \
      "$(contains "$OUT" './haive up' && echo 1 || echo 0)" "$OUT"
assert_complete "$DIR" pull

echo "[boot-failures] scenario 2: the pull works and the stack does not start"
run up up
check "up: the installer fails" "$([ "$CODE" -ne 0 ] && echo 1 || echo 0)" "exit was $CODE"
check "up: it got past the pull" \
      "$(contains "$OUT" 'Starting Haive' && echo 1 || echo 0)" "$OUT"
check "up: the message names the retry command" \
      "$(contains "$OUT" './haive up' && echo 1 || echo 0)" "$OUT"
check "up: and how to see why" \
      "$(contains "$OUT" './haive logs' && echo 1 || echo 0)" "$OUT"
assert_complete "$DIR" up

echo "[boot-failures] scenario 3: nothing fails"
run ok none
check "ok: the installer succeeds" "$([ "$CODE" -eq 0 ] && echo 1 || echo 0)" "exit $CODE: $OUT"
check "ok: it reports the install as running" \
      "$(contains "$OUT" 'is running' && echo 1 || echo 0)" "$OUT"
assert_complete "$DIR" ok

if [ "$failures" -gt 0 ]; then
  echo "[boot-failures] $failures FAILED"
  exit 1
fi
echo "[boot-failures] all checks passed"
