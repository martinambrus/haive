#!/bin/sh
#
# Haive one-line installer (RUN-IT).
#
#   curl -fsSL https://raw.githubusercontent.com/martinambrus/haive/main/install/install.sh | sh
#
# Installs a PUBLISHED release: fetches a versioned compose bundle, generates this install's own
# secrets, pulls images and boots the stack. It builds nothing and clones nothing — a contributor
# wanting to build from source wants `pnpm docker:dev` instead, which this script never touches.
#
# POSIX sh on purpose: the documented line pipes into `sh`, so bashisms would break exactly the
# invocation the docs give. No arrays, no [[ ]], no pipefail.
#
# Read-then-run is supported and encouraged: download this file, read it, run it.

set -eu

REPO="${HAIVE_REPO:-martinambrus/haive}"
REGISTRY_DEFAULT="ghcr.io/martinambrus"
RAW="https://raw.githubusercontent.com/${REPO}"
RELEASES="https://github.com/${REPO}/releases/download"
API="https://api.github.com/repos/${REPO}"

VERSION=""
INSTALL_DIR=""
INSTALL_ID=""
CHANNEL="public"
CHANNEL_REGISTRY="$REGISTRY_DEFAULT"
REGISTRY_USER=""
CHECK_ONLY=0
FORCE=0
NO_START=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
# Every failure names the fix. A stack trace tells the user nothing they can act on.
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Haive installer

  install.sh [options]

  --version <v>   Install this release (e.g. 0.1.4, or 'latest' / 'next'). An alias is
                  resolved to a concrete version and PINNED, so the install cannot drift
                  onto a moving tag. Default: latest (public channel only).
  --dir <path>    Install directory. Default: \$HOME/haive
  --install-id    Names every container, volume, network and database this install owns
                  ([a-z0-9_], default 'haive'). Give a SECOND install on this machine its
                  own id, or it shares the first one's repositories and RAG data. It
                  identifies the install, never the version, and changing it later orphans
                  what the install owns rather than renaming it — so choose it now.
  --channel <id>  Release channel. Default: public
                  A non-public channel requires an explicit --version <v>.
  --channel-registry <prefix>  Channel image registry. Default: ghcr.io/martinambrus
  --registry-user <u>  Registry login user. Token: HAIVE_REGISTRY_TOKEN or a hidden prompt.
  --check         Run the preflight checks and exit, changing nothing.
  --force         Install into a non-empty directory.
  --no-start      Write the install but do not boot the stack.
  -h, --help      This text.

The installer never upgrades an existing install: re-running it against one is refused.
Use the Upgrade page in the admin console, or ./haive upgrade in the install directory.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; [ -n "$VERSION" ] || die "--version needs a value"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; [ -n "$INSTALL_DIR" ] || die "--dir needs a value"; shift 2 ;;
    --install-id) INSTALL_ID="${2:-}"; [ -n "$INSTALL_ID" ] || die "--install-id needs a value"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; [ -n "$CHANNEL" ] || die "--channel needs a value"; shift 2 ;;
    --channel-registry) CHANNEL_REGISTRY="${2:-}"; [ -n "$CHANNEL_REGISTRY" ] || die "--channel-registry needs a value"; shift 2 ;;
    --registry-user) REGISTRY_USER="${2:-}"; [ -n "$REGISTRY_USER" ] || die "--registry-user needs a value"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    --force)   FORCE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

if [ "$CHANNEL" != "public" ]; then
  # Do not trace, export or leave the token in the environment of any subprocess.
  set +x
  unset REGISTRY_TOKEN
  REGISTRY_TOKEN=${HAIVE_REGISTRY_TOKEN:-}
  unset HAIVE_REGISTRY_TOKEN
fi

# Match scripts/build-channel.mjs CHANNEL and PREFIX before contacting any registry.
case "$CHANNEL" in *[!a-z0-9-]*) die "invalid --channel" ;; esac
case "$CHANNEL_REGISTRY" in *[!a-z0-9/._:-]*) die "invalid --channel-registry" ;; esac
printf '%s\n' "$CHANNEL" | LC_ALL=C grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' \
  || die "invalid --channel (use 1-32 lowercase letters, digits or dashes; start and end with a letter or digit)"
printf '%s\n' "$CHANNEL_REGISTRY" | LC_ALL=C grep -Eq '^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$' \
  || die "invalid --channel-registry (use a registry host and optional repository prefix, without a scheme)"

if [ "$CHANNEL" != "public" ]; then
  case "$VERSION" in
    ''|latest|next) die "channel installs require an explicit --version <v>; latest and next are public release aliases" ;;
  esac
fi

# ── Preflight ────────────────────────────────────────────────────────────────
# Prerequisites are CHECKED, never installed. Docker is privileged, OS-specific, and on
# macOS/Windows it is Docker Desktop, whose licence nobody can accept on the user's behalf.
# A `curl | sh` that also installed a root-equivalent daemon would be a far larger trust ask
# than one that boots containers.

need_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say ""
  say "Missing: $1"
  say "  $2"
  return 1
}

docker_install_hint() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) say "  Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/" ;;
    Linux)  say "  Install Docker Engine:  https://get.docker.com" ;;
    *)      say "  Install Docker Desktop: https://docs.docker.com/desktop/" ;;
  esac
}

preflight() {
  step "Checking prerequisites"
  ok=1

  if ! command -v docker >/dev/null 2>&1; then
    say "Missing: docker"; docker_install_hint; ok=0
  else
    say "  docker            found"
  fi

  if [ "$ok" -eq 1 ]; then
    if ! docker info >/dev/null 2>&1; then
      say "Missing: a reachable Docker daemon"
      say "  Docker is installed but not answering. Start Docker Desktop, or:"
      say "    sudo systemctl start docker"
      say "  If you are not in the 'docker' group, add yourself and log out and back in:"
      say "    sudo usermod -aG docker \$USER"
      ok=0
    else
      say "  docker daemon     reachable"
    fi
  fi

  if [ "$ok" -eq 1 ]; then
    if ! docker compose version >/dev/null 2>&1; then
      say "Missing: Docker Compose v2"
      say "  'docker compose' (with a space) is required; the old 'docker-compose' will not do."
      docker_install_hint
      ok=0
    else
      say "  docker compose    $(docker compose version --short 2>/dev/null || echo v2)"
    fi
  fi

  need_cmd curl "Install curl with your package manager (apt install curl / brew install curl)." || ok=0

  # The master KEK must be RANDOM. No fallback to anything predictable exists, so the absence of
  # every source of randomness is a hard stop rather than a degradation.
  if command -v openssl >/dev/null 2>&1; then
    say "  openssl           found"
  elif [ -r /dev/urandom ]; then
    say "  openssl           absent, using /dev/urandom"
  else
    say "Missing: a source of randomness (openssl or /dev/urandom)"
    say "  Haive generates this install's own encryption key and refuses to use a predictable one."
    ok=0
  fi

  # Advisory, never blocking: a small machine can still run Haive, just fewer agents at once.
  if [ -r /proc/meminfo ]; then
    kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    gb=$(( kb / 1024 / 1024 ))
    if [ "$gb" -gt 0 ]; then
      if [ "$gb" -lt 8 ]; then
        warn "this machine has ${gb} GB RAM. Haive budgets agents and runtimes against roughly 70% of
         it, so expect one agent at a time. 16 GB or more is comfortable."
      else
        say "  memory            ${gb} GB"
      fi
    fi
  fi

  [ "$ok" -eq 1 ] || die "prerequisites are missing (see above). Nothing was changed."
  say ""
  say "Ready to install."
}

# ── Version resolution ───────────────────────────────────────────────────────
# An alias is resolved to a concrete version BEFORE anything is written. An install left pointing
# at a moving tag changes underneath its owner on the next `docker compose up` — an unrequested
# upgrade with no migration gate, no snapshot and no health check.

resolve_version() {
  want="${1:-latest}"
  case "$want" in
    ""|latest)
      tag=$(curl -fsSL "${API}/releases/latest" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      [ -n "$tag" ] || die "could not resolve the latest release from GitHub. Check your network, or pass --version <v>."
      ;;
    next)
      # Newest release including prereleases. The API lists newest-first.
      tag=$(curl -fsSL "${API}/releases?per_page=1" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      [ -n "$tag" ] || die "could not resolve a prerelease from GitHub. Check your network, or pass --version <v>."
      ;;
    *)
      case "$want" in v*) tag="$want" ;; *) tag="v${want}" ;; esac
      ;;
  esac
  printf '%s' "$tag"
}

# Authenticate and validate before creating anything in the destination. The staged config
# becomes this install's .docker only after the entire manifest has passed.
read_channel_manifest() {
  CHANNEL_UMASK=$(umask)
  umask 077
  CHANNEL_SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/haive-install.XXXXXXXX")
  CHANNEL_CONTAINER=""
  CHANNEL_TTY=""
  CHANNEL_ENV_CREATED=0
  CHANNEL_FINAL_CLAIMED=0
  CHANNEL_PLACED=0
  cleanup_channel() {
    if [ -n "$CHANNEL_TTY" ]; then stty "$CHANNEL_TTY" < /dev/tty || warn "could not restore terminal settings"; fi
    if [ -n "$CHANNEL_CONTAINER" ]; then
      docker rm -f "$CHANNEL_CONTAINER" >/dev/null 2>&1 \
        || warn "could not remove manifest container $CHANNEL_CONTAINER; run docker rm -f $CHANNEL_CONTAINER"
    fi
    if [ "$CHANNEL_PLACED" -eq 0 ]; then
      if [ "$CHANNEL_FINAL_CLAIMED" -eq 1 ]; then rm -rf "$INSTALL_DIR/.docker"; fi
      if [ "$CHANNEL_ENV_CREATED" -eq 1 ]; then rm -f "$INSTALL_DIR/.env"; fi
    fi
    rm -rf "$CHANNEL_SCRATCH"
  }
  trap cleanup_channel 0
  trap 'exit 1' HUP INT TERM
  mkdir "$CHANNEL_SCRATCH/.docker"
  chmod 700 "$CHANNEL_SCRATCH/.docker"
  CHANNEL_USER_CONFIG=${DOCKER_CONFIG:-${HOME:-/}/.docker}
  CHANNEL_CONTEXT=''
  if [ -f "$CHANNEL_USER_CONFIG/config.json" ]; then
    # Copy only the top-level selection, preserving its JSON string escaping. Never
    # copy the user config itself: it may name auths or credential helpers.
    CHANNEL_CONTEXT=$(LC_ALL=C awk '
      { s=s $0 "\n" }
      END {
        depth=0
        for(p=1;p<=length(s);p++) {
          c=substr(s,p,1)
          if(c=="\"") {
            start=p++
            while(p<=length(s)) {
              c=substr(s,p,1)
              if(c=="\\") p++
              else if(c=="\"") break
              p++
            }
            token=substr(s,start,p-start+1)
            if(depth==1 && token=="\"currentContext\"") {
              q=p+1; while(substr(s,q,1) ~ /[ \t\r\n]/) q++
              if(substr(s,q,1)!=":") continue
              p=q+1
              while(substr(s,p,1) ~ /[ \t\r\n]/) p++
              if(substr(s,p,1)!="\"") exit 1
              start=p++
              while(p<=length(s)) {
                c=substr(s,p,1)
                if(c=="\\") p++
                else if(c=="\"") { print substr(s,start,p-start+1); exit }
                p++
              }
              exit 1
            }
          } else if(c=="{" || c=="[") depth++
          else if(c=="}" || c=="]") depth--
        }
      }
    ' "$CHANNEL_USER_CONFIG/config.json") || die "cannot read Docker currentContext"
  fi
  # Decode the selected JSON string for Docker's name-hashed context store. The
  # original JSON token above is retained verbatim in the scratch config.
  CHANNEL_CONTEXT_NAME=$(printf '%s\n' "$CHANNEL_CONTEXT" | LC_ALL=C awk '
    function hex(t,   i,n,c) {
      n=0; for(i=1;i<=length(t);i++) {
        c=index("0123456789abcdef",tolower(substr(t,i,1)))-1
        if(c<0) exit 1
        n=n*16+c
      }; return n
    }
    function utf8(n) {
      if(n==0 || n>1114111 || (n>=55296 && n<=57343)) exit 1
      if(n<128) return sprintf("%c",n)
      if(n<2048) return sprintf("%c%c",192+int(n/64),128+n%64)
      if(n<65536) return sprintf("%c%c%c",224+int(n/4096),128+int(n/64)%64,128+n%64)
      return sprintf("%c%c%c%c",240+int(n/262144),128+int(n/4096)%64,128+int(n/64)%64,128+n%64)
    }
    {
      for(p=2;p<length($0);p++) {
        c=substr($0,p,1)
        if(c=="\\") {
          c=substr($0,++p,1)
          if(c=="u") {
            if(p+4>=length($0)) exit 1
            n=hex(substr($0,p+1,4)); p+=4
            if(n>=55296 && n<=56319) {
              if(substr($0,p+1,2)!="\\u" || p+6>=length($0)) exit 1
              low=hex(substr($0,p+3,4)); if(low<56320 || low>57343) exit 1
              n=65536+(n-55296)*1024+low-56320; p+=6
            }
            c=utf8(n)
          } else if(c=="b") c=sprintf("%c",8)
          else if(c=="f") c=sprintf("%c",12)
          else if(c=="n") c="\n"
          else if(c=="r") c="\r"
          else if(c=="t") c="\t"
          else if(c!="\"" && c!="\\" && c!="/") exit 1
        }
        printf "%s",c
      }
    }
  ') || die "cannot decode Docker currentContext"
  copy_channel_context() {
    [ -n "$1" ] && [ "$1" != default ] || return 0
    if command -v sha256sum >/dev/null 2>&1; then
      CHANNEL_HASH=$(printf '%s' "$1" | sha256sum) || die "cannot hash selected Docker context"
    elif command -v shasum >/dev/null 2>&1; then
      CHANNEL_HASH=$(printf '%s' "$1" | shasum -a 256) || die "cannot hash selected Docker context"
    else
      die "selected Docker contexts require sha256sum or shasum -a 256"
    fi
    CHANNEL_HASH=${CHANNEL_HASH%% *}
    [ "${#CHANNEL_HASH}" -eq 64 ] || die "invalid selected Docker context hash"
    case "$CHANNEL_HASH" in *[!0-9a-f]*) die "invalid selected Docker context hash" ;; esac
    [ -d "$CHANNEL_USER_CONFIG/contexts/meta/$CHANNEL_HASH" ] \
      || die "selected Docker context $1 has no metadata directory"
    for kind in meta tls; do
      if [ -d "$CHANNEL_USER_CONFIG/contexts/$kind/$CHANNEL_HASH" ]; then
        mkdir -p "$CHANNEL_SCRATCH/.docker/contexts/$kind"
        # Dereference every link; chmod must only ever touch our private copy.
        cp -RL "$CHANNEL_USER_CONFIG/contexts/$kind/$CHANNEL_HASH" "$CHANNEL_SCRATCH/.docker/contexts/$kind/$CHANNEL_HASH"
      fi
    done
  }
  copy_channel_context "${DOCKER_CONTEXT:-}"
  if [ -n "$CHANNEL_CONTEXT_NAME" ] && [ "$CHANNEL_CONTEXT_NAME" != default ]; then
    if [ "$CHANNEL_CONTEXT_NAME" != "${DOCKER_CONTEXT:-}" ]; then copy_channel_context "$CHANNEL_CONTEXT_NAME"
    fi
  fi
  if [ -d "$CHANNEL_SCRATCH/.docker/contexts" ]; then chmod -R go-rwx "$CHANNEL_SCRATCH/.docker/contexts"; fi
  export DOCKER_CONFIG="$CHANNEL_SCRATCH/.docker"
  # A nonempty auth map prevents Docker from automatically selecting a Desktop credential
  # helper. Login replaces this empty credential; this config must remain self-contained.
  printf '{"auths":{"%s":{"auth":"Og=="}}}\n' "${CHANNEL_REGISTRY%%/*}" > "$DOCKER_CONFIG/config.json"
  if [ -n "$CHANNEL_CONTEXT" ]; then
    printf '{"auths":{"%s":{"auth":"Og=="}},"currentContext":%s}\n' "${CHANNEL_REGISTRY%%/*}" "$CHANNEL_CONTEXT" > "$DOCKER_CONFIG/config.json"
  fi
  chmod 600 "$DOCKER_CONFIG/config.json"
  [ -n "$REGISTRY_USER" ] || die "--registry-user is required for a channel install"
  if [ -z "$REGISTRY_TOKEN" ]; then
    [ -r /dev/tty ] || die "set HAIVE_REGISTRY_TOKEN or run in a terminal for the registry token prompt"
    CHANNEL_TTY=$(stty -g < /dev/tty) || die "cannot read terminal settings"
    stty -echo < /dev/tty
    printf 'Registry token: ' > /dev/tty
    IFS= read -r REGISTRY_TOKEN < /dev/tty || die "could not read registry token"
    stty "$CHANNEL_TTY" < /dev/tty
    CHANNEL_TTY=""
    printf '\n' > /dev/tty
  fi
  [ -n "$REGISTRY_TOKEN" ] || die "registry token is empty"
  if ! printf '%s\n' "$REGISTRY_TOKEN" | docker login "${CHANNEL_REGISTRY%%/*}" --username "$REGISTRY_USER" --password-stdin >/dev/null 2>&1; then
    REGISTRY_TOKEN=""
    die "registry login failed; check the registry user and token"
  fi
  REGISTRY_TOKEN=""
  chmod 600 "$DOCKER_CONFIG/config.json"
  MANIFEST_IMAGE="${CHANNEL_REGISTRY}/haive-${CHANNEL}-release:${PINNED}"
  docker pull "$MANIFEST_IMAGE" >/dev/null 2>&1 || die "could not pull channel release image $MANIFEST_IMAGE"
  CHANNEL_CONTAINER="hi-manifest-$(basename "$CHANNEL_SCRATCH")"
  docker create --name "$CHANNEL_CONTAINER" "$MANIFEST_IMAGE" /unused >/dev/null \
    || die "could not create the channel manifest container"
  docker cp "$CHANNEL_CONTAINER:/release.json" "$CHANNEL_SCRATCH/release.json" >/dev/null 2>&1 \
    || die "could not read /release.json from the channel release image"
  docker rm -f "$CHANNEL_CONTAINER" >/dev/null 2>&1 || die "could not remove manifest container $CHANNEL_CONTAINER"
  CHANNEL_CONTAINER=""
  [ -f "$CHANNEL_SCRATCH/release.json" ] && [ ! -L "$CHANNEL_SCRATCH/release.json" ] \
    || die "channel release.json must be a regular file"
  [ "$(wc -c < "$CHANNEL_SCRATCH/release.json")" -le 1048576 ] || die "channel manifest is too large"
  # Recursive JSON grammar, not a grep for strings that might be inside an unrelated object.
  # awk is already required by preflight and the port probe; no host JSON runtime is needed.
  if ! LC_ALL=C awk -v channel="$CHANNEL" -v version="$PINNED" -v registry="$CHANNEL_REGISTRY" '
    function ws() { while (substr(s,p,1) ~ /[ \t\r\n]/ && p <= length(s)) p++ }
    function fail() { bad=1; exit 1 }
    function str(   c,t,e,h) {
      if (substr(s,p++,1) != "\"") fail()
      t=""
      while (p <= length(s)) {
        c=substr(s,p++,1)
        if (c == "\"") return t
        if (c ~ /[[:cntrl:]]/) fail()
        if (c == "\\") {
          e=substr(s,p++,1)
          if (e == "u") { h=substr(s,p,4); if (length(h)!=4 || h ~ /[^0-9a-fA-F]/) fail(); p+=4; t=t "\\u" h }
          else { if (e !~ /^["\\\/bfnrt]$/) fail(); t=t "\\" e }
        } else t=t c
      }
      fail()
    }
    function val(path,depth,   c,k,t,n,seen,a) {
      if (depth > 64) fail()
      ws(); c=substr(s,p,1)
      if (c == "{") {
        p++; ws(); if (substr(s,p,1)=="}") { p++; return }
        while (1) {
          ws(); k=str(); if (index(k,"\\") || index(k,"/")) fail()
          if ((path SUBSEP k) in keys) fail(); keys[path SUBSEP k]=1
          ws(); if (substr(s,p++,1)!=":") fail()
          val(path "/" k,depth+1); ws(); c=substr(s,p++,1)
          if (c=="}") return
          if (c!=",") fail()
        }
      } else if (c == "[") {
        p++; ws(); if (substr(s,p,1)=="]") { p++; return }
        n=0; while (1) { val(path "/[" n++ "]",depth+1); ws(); c=substr(s,p++,1); if (c=="]") return; if(c!=",") fail() }
      } else if (c == "\"") { t=str(); strings[path]=t }
      else if (match(substr(s,p,5),/^(true|false|null)/)) p+=RLENGTH
      else if (c == "-" || c ~ /^[0-9]$/) {
        if (c == "-") p++
        c=substr(s,p,1)
        if (c == "0") p++
        else {
          if (c !~ /^[1-9]$/) fail()
          do { p++ } while (substr(s,p,1) ~ /^[0-9]$/)
        }
        if (substr(s,p,1) == ".") {
          p++; if (substr(s,p,1) !~ /^[0-9]$/) fail()
          do { p++ } while (substr(s,p,1) ~ /^[0-9]$/)
        }
        if (substr(s,p,1) ~ /^[eE]$/) {
          p++; if (substr(s,p,1) ~ /^[+-]$/) p++
          if (substr(s,p,1) !~ /^[0-9]$/) fail()
          do { p++ } while (substr(s,p,1) ~ /^[0-9]$/)
        }
      }
      else fail()
    }
    { s=s $0 "\n" }
    END {
      if (bad) exit 1
      p=1; ws(); if(substr(s,p,1)!="{") fail(); val("",0); ws(); if(p<=length(s)) fail()
      if(strings["/channel"]!=channel || strings["/version"]!=version) fail()
      split("api worker web builder",hosts," ")
      for(i=1;i<=4;i++) {
        pin=strings["/images/" hosts[i]]; prefix=registry "/haive-" channel "-" hosts[i] "@sha256:"
        if(index(pin,prefix)!=1) fail()
        digest=substr(pin,length(prefix)+1)
        if(length(digest)!=64 || digest ~ /[^0-9a-f]/) fail()
      }
      for(i=1;i<=3;i++) print strings["/images/" hosts[i]]
    }
  ' "$CHANNEL_SCRATCH/release.json" > "$CHANNEL_SCRATCH/pins"; then
    die "invalid channel manifest: channel, version and all image pins must match the requested registry release"
  fi
  API_IMAGE=$(sed -n '1p' "$CHANNEL_SCRATCH/pins")
  WORKER_IMAGE=$(sed -n '2p' "$CHANNEL_SCRATCH/pins")
  WEB_IMAGE=$(sed -n '3p' "$CHANNEL_SCRATCH/pins")
  umask "$CHANNEL_UMASK"
}

# ── Install ──────────────────────────────────────────────────────────────────

# ── Host ports ───────────────────────────────────────────────────────────────
# Probed, not assumed. The defaults collide in practice rather than in theory: Haive pins
# DDEV's global mailpit to 8025-8026, so any machine that has ever run a Haive-managed DDEV
# project already holds this installer's default mailpit port — MEASURED, `ddev-router`
# publishing 127.0.0.1:8025-8026. A second Haive install collides on all three.
#
# `ss` sees every listener, including non-docker ones, and is the authority where present.
# Docker's own published-port list is the fallback, because the collisions that actually
# happen here are with other containers. Neither present means no probe: compose then reports
# the bind failure itself, which is a worse message but not a wrong outcome.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$" && return 0
    return 1
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(^|[^0-9])$1->" && return 0
  fi
  return 1
}

# First free port at or after $1. Bounded so a pathological host fails loudly instead of looping.
free_port() {
  p=$1
  n=0
  while [ "$n" -lt 50 ]; do
    port_in_use "$p" || { printf '%s' "$p"; return 0; }
    p=$((p + 1))
    n=$((n + 1))
  done
  die "could not find a free port at or after $1 after 50 tries. Free one, or pass the port explicitly in .env after installing with --no-start."
}

rand_hex() {
  # $1 = bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'
  fi
}

fetch() {
  # $1 = url, $2 = dest
  curl -fsSL "$1" -o "$2" || die "could not download $1"
}

# Validated here rather than at first use: it names Docker volumes and Postgres databases, and
# compose builds both `<id>-api` and `<id>_repos` from it without being able to convert between
# the conventions — so a `-` inside it would leave the two halves of one install disagreeing.
: "${INSTALL_ID:=haive}"
case "$INSTALL_ID" in
  *[!a-z0-9_]*|[!a-z0-9]*|"") die "--install-id must be [a-z0-9_] starting with a letter or digit, and was '$INSTALL_ID'." ;;
esac

# An install id that already owns state on this machine is refused, and this is the guard that
# matters most. Postgres applies POSTGRES_PASSWORD only when it INITIALISES an empty data
# directory, so pointing a fresh install at an existing volume does not re-key it — MEASURED, the
# install failed with `password authentication failed for user "haive"` after silently adopting a
# `haive_postgres_data` created months earlier by a dev stack. The failure is the lucky outcome:
# had the passwords matched, a "fresh install" would have come up on someone else's live database
# with their tasks, repositories and secrets in it, and said nothing.
existing_state() {
  docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${INSTALL_ID}_postgres_data" && return 0
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${INSTALL_ID}-api" && return 0
  return 1
}
if existing_state; then
  die "an install named '${INSTALL_ID}' already has data on this machine.
       Its Postgres volume (${INSTALL_ID}_postgres_data) or containers are still here, and a new
       install would come up on that existing database rather than a fresh one.
         - to run a SECOND Haive alongside it:   --install-id <another-name>
         - to reinstall this one from scratch:   remove its volumes first (see its uninstall script)
         - to keep it and upgrade instead:       use the admin console's Maintenance page"
fi

preflight
if [ "$CHECK_ONLY" -eq 1 ] && [ "$CHANNEL" = "public" ]; then
  say ""; say "--check: nothing was installed."; exit 0
fi

step "Resolving the release"
TAG=$(resolve_version "$VERSION")
PINNED="${TAG#v}"
say "  requested         ${VERSION:-latest}"
say "  resolved          ${PINNED}  (tag ${TAG})"

# Verify the release EXISTS before generating a secret or pulling an image, so a typo costs
# nothing. Its manifest is the artefact an upgrade reads too.
MANIFEST_URL="${RELEASES}/${TAG}/release.json"
if [ "$CHANNEL" = "public" ]; then
  curl -fsSL -o /dev/null "$MANIFEST_URL" 2>/dev/null \
  || die "release ${TAG} has no published manifest at ${MANIFEST_URL}.
       Check the version, or list what exists: https://github.com/${REPO}/releases"
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  read_channel_manifest
  say "  Channel           $CHANNEL ($CHANNEL_REGISTRY)"
  say "  manifest          verified for $PINNED"
  say "--check: nothing was installed."
  exit 0
fi
if [ "$CHANNEL" = "public" ]; then say "  manifest          found"; fi

: "${INSTALL_DIR:=${HOME:-.}/${INSTALL_ID}}"
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;; esac

if [ "$CHANNEL" != "public" ]; then
  # Match path.join's lexical form without requiring the destination to exist.
  # Parent traversal is refused below rather than resolving it through possible symlinks.
  INSTALL_DIR=$(printf '%s\n' "$INSTALL_DIR" | awk -F/ '{
    out=""; for (i=1; i<=NF; i++) if ($i!="" && $i!=".") out=out "/" $i
    print out=="" ? "/" : out
  }')
fi

if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  if [ -f "$INSTALL_DIR/.env" ]; then
    die "$INSTALL_DIR already holds a Haive install.
       The installer never upgrades: running an install command is not consent to migrate a live
       database, and none of the drain, snapshot or health-gate steps that make an upgrade safe
       happen here. Upgrade from the admin console's Maintenance page, or:
         cd $INSTALL_DIR && ./haive upgrade --version <v>"
  fi
  [ "$FORCE" -eq 1 ] || die "$INSTALL_DIR is not empty. Pass --force to install into it anyway."
fi

if [ "$CHANNEL" != "public" ]; then
  [ ! -e "$INSTALL_DIR/.docker" ] && [ ! -L "$INSTALL_DIR/.docker" ] || die "$INSTALL_DIR/.docker already exists; choose a clean install directory"
fi

if [ "$CHANNEL" != "public" ]; then
  # Keep env values literal in Compose and in the generated host helper.
  case "$INSTALL_DIR" in *[!a-zA-Z0-9_./\ -]*|*'..'*|*'//'*|*/.) die "channel install directory must be a normalized absolute path using letters, digits, spaces, _, - and ." ;; esac
  [ "$INSTALL_DIR" != / ] || die "channel install directory cannot be the filesystem root"
  INSTALL_DIR=${INSTALL_DIR%/}
  read_channel_manifest
  say "  manifest          verified for $PINNED"
fi

step "Writing the install to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/snapshots"
cd "$INSTALL_DIR"

# The compose bundle is fetched AT THE TAG, so it always matches the images being pinned.
fetch "${RAW}/${TAG}/docker-compose.yml"     docker-compose.yml
fetch "${RAW}/${TAG}/docker-compose.run.yml" docker-compose.run.yml
say "  compose bundle    docker-compose.yml + docker-compose.run.yml"

# GPU layering, mirroring scripts/dev.sh so a RUN-IT host makes the same choice a dev host does.
GPU_MODE="CPU"
GPU_FILE=""
has_nvidia_runtime() {
  i=1
  while [ "$i" -le 3 ]; do
    if docker info --format '{{range $k, $v := .Runtimes}}{{println $k}}{{end}}' 2>/dev/null | grep -qx nvidia; then
      return 0
    fi
    [ "$i" -lt 3 ] && sleep 1
    i=$((i + 1))
  done
  return 1
}
if [ "${HAIVE_GPU:-auto}" = "cpu" ]; then
  GPU_MODE="CPU (forced)"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && has_nvidia_runtime; then
  fetch "${RAW}/${TAG}/docker-compose.gpu.yml" docker-compose.gpu.yml
  GPU_FILE="docker-compose.gpu.yml"; GPU_MODE="NVIDIA"
elif [ -e /dev/dri/renderD128 ]; then
  fetch "${RAW}/${TAG}/docker-compose.vulkan.yml" docker-compose.vulkan.yml
  GPU_FILE="docker-compose.vulkan.yml"; GPU_MODE="Vulkan (Intel/AMD)"
fi
say "  ollama            ${GPU_MODE}"

WEB_PORT=$(free_port 3000)
API_PORT=$(free_port "$((WEB_PORT + 1))")
MAILPIT_PORT=$(free_port 8025)
say "  ports             web ${WEB_PORT}, api ${API_PORT}, mail ${MAILPIT_PORT}"

# Secrets. Generated per install and stored only here — a shipped default would mean every install
# shared one encryption key and any user could decrypt any other's secrets.
if [ ! -f .env ]; then
  KEY=$(rand_hex 32)
  JWT=$(rand_hex 32)
  PGPW=$(rand_hex 16)
  # Explicit, not `A && B && C || die`: that reads as if-then-else and is not one — shellcheck
  # says so as SC2015 — and the answer here has to be unambiguous, since the branch it guards is
  # the one that would otherwise write an install with an empty encryption key.
  if [ -z "$KEY" ] || [ -z "$JWT" ] || [ -z "$PGPW" ]; then
    die "could not generate secrets. Nothing was installed."
  fi
  umask 077
  if [ "$CHANNEL" != "public" ]; then CHANNEL_ENV_CREATED=1; fi
  cat > .env <<EOF
# Haive install — generated $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Keep this file. CONFIG_ENCRYPTION_KEY is the master key for every secret this install stores;
# lose it and stored credentials cannot be decrypted.

HAIVE_VERSION=${PINNED}
HAIVE_REGISTRY=${REGISTRY_DEFAULT}

# Names every container, volume, network and database this install owns. Two installs on one
# machine need two ids, or the second silently mounts the first one's cloned repositories.
# It identifies the INSTALL, never the version — the version lives in HAIVE_VERSION above.
HAIVE_INSTALL_ID=${INSTALL_ID}
COMPOSE_PROJECT_NAME=${INSTALL_ID}

CONFIG_ENCRYPTION_KEY=${KEY}
JWT_SECRET=${JWT}
POSTGRES_PASSWORD=${PGPW}

# Ports on the host. Change these if something already holds them.
HAIVE_WEB_PORT=${WEB_PORT}
HAIVE_API_PORT=${API_PORT}
HAIVE_MAILPIT_PORT=${MAILPIT_PORT}

# Read-only view of your filesystem, used to import a repository that already exists on disk.
# Written explicitly rather than defaulted: compose expands \${HOME}, which PowerShell does not
# set, and the mount then fails with "empty section between colons".
HOST_REPO_ROOT=${HOME:-/}

# Where this install lives, as the DOCKER DAEMON sees it. The api hands this to \`docker run -v\`
# when it launches the updater, and the daemon resolves it on the host — nothing inside a
# container can work it out. Without it the in-app Upgrade button is not offered.
HAIVE_INSTALL_DIR_HOST=${INSTALL_DIR}
EOF
  if [ "$CHANNEL" != "public" ]; then
    cat >> .env <<EOF

HAIVE_CHANNEL=${CHANNEL}
HAIVE_CHANNEL_REGISTRY=${CHANNEL_REGISTRY}
DOCKER_CONFIG=${INSTALL_DIR}/.docker
HAIVE_API_IMAGE=${API_IMAGE}
HAIVE_WORKER_IMAGE=${WORKER_IMAGE}
HAIVE_WEB_IMAGE=${WEB_IMAGE}
EOF
  fi
  chmod 600 .env
  say "  secrets           generated (.env, mode 600)"
fi

if [ "$CHANNEL" != "public" ]; then
  # mkdir is the portable exclusive claim: it refuses even a concurrent link or
  # directory, instead of mv merging the credential into someone else’s tree.
  mkdir -m 700 .docker 2>/dev/null || die "$INSTALL_DIR/.docker already exists or cannot be created; choose a clean install directory"
  CHANNEL_FINAL_CLAIMED=1
  # Keep both environment and config selections for install-time compose and
  # the host helper. Scratch already holds only the selected contexts.
  case "$CHANNEL_CONTEXT" in
    ''|'""'|'"default"')
        awk '
          { s=s $0 "\n" }
          END {
            gsub(/,[ \t\r\n]*"currentContext"[ \t\r\n]*:[ \t\r\n]*"(default)?"/, "", s)
            gsub(/"currentContext"[ \t\r\n]*:[ \t\r\n]*"(default)?"[ \t\r\n]*,/, "", s)
            printf "%s", s
          }
        ' "$DOCKER_CONFIG/config.json" > "$CHANNEL_SCRATCH/config.json"
        mv "$CHANNEL_SCRATCH/config.json" "$DOCKER_CONFIG/config.json"
        chmod 600 "$DOCKER_CONFIG/config.json"
      ;;
  esac
  for entry in "$CHANNEL_SCRATCH/.docker/"*; do
    mv "$entry" ".docker/${entry##*/}" || die "could not place registry credentials; retry the install"
  done
  CHANNEL_PLACED=1
  export DOCKER_CONFIG="$INSTALL_DIR/.docker"
fi

# ── Helper scripts ───────────────────────────────────────────────────────────

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.run.yml"
[ -n "$GPU_FILE" ] && COMPOSE_FILES="$COMPOSE_FILES -f $GPU_FILE"

# Empty substitutions preserve the public helper byte for byte.
# These literals are expanded by the generated helper, not by the installer.
# shellcheck disable=SC2016
{
CHANNEL_HELPER_ENV=""
CHANNEL_PULL=""
CHANNEL_UPGRADE_ENV=""
CHANNEL_CHANGE_USAGE=""
LOAD_INSTALL_ENV='. ./.env'
MANIFEST_ARGS='      --manifest "https://github.com/'"${REPO}"'/releases/download/v${v#v}/release.json" \
'
if [ "$CHANNEL" != "public" ]; then
  CHANNEL_HELPER_ENV='unset HAIVE_REGISTRY_TOKEN
while IFS= read -r line; do
  case "$line" in
    HAIVE_*=*|COMPOSE_PROJECT_NAME=*|POSTGRES_*=*|CONFIG_ENCRYPTION_KEY=*|JWT_SECRET=*|DOCKER_CONFIG=*) export "$line" ;;
  esac
done < .env
'
  CHANNEL_PULL='  pull)    shift; $DC pull "$@" ;;
'
  CHANNEL_CHANGE_USAGE=' [--change-channel <channel>]'
  LOAD_INSTALL_ENV=': # install settings were read above as data'
  CHANNEL_UPGRADE_ENV='      -e DOCKER_HOST=unix:///var/run/docker.sock \
      -e DOCKER_CONFIG=/install/.docker \
      -e HAIVE_INSTALL_DIR_HOST="${HAIVE_INSTALL_DIR_HOST}" \
'
  MANIFEST_ARGS='      --channel "${HAIVE_CHANNEL}" \
      --manifest-image "${HAIVE_CHANNEL_REGISTRY}/haive-${HAIVE_CHANNEL}-release:${v#v}" \
      --version "${v#v}" \
'
fi
}

cat > haive <<EOF
#!/bin/sh
# Haive control script for this install. Generated by the installer.
set -eu
cd "\$(dirname "\$0")"
${CHANNEL_HELPER_ENV}DC="docker compose ${COMPOSE_FILES}"
case "\${1:-}" in
${CHANNEL_PULL}  up)      shift; \$DC up -d "\$@" ;;
  down)    shift; \$DC down "\$@" ;;
  logs)    shift; \$DC logs -f "\$@" ;;
  ps)      shift; \$DC ps "\$@" ;;
  version) curl -fsS http://localhost:\${HAIVE_API_PORT:-3001}/version; echo ;;
  upgrade)
    shift
    v=""
    while [ \$# -gt 0 ]; do case "\$1" in --version) v="\${2:-}"; shift 2 ;; *) break ;; esac; done
    [ -n "\$v" ] || { echo "usage: ./haive upgrade --version <v> [--force]${CHANNEL_CHANGE_USAGE}" >&2; exit 2; }
    # The updater runs OUTSIDE this compose project: a process cannot bring itself down and
    # survive to verify the result or roll it back.
    ${LOAD_INSTALL_ENV}
    DATABASE_URL="postgres://\${POSTGRES_USER:-haive}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-haive}" \\
    CONFIG_ENCRYPTION_KEY="\${CONFIG_ENCRYPTION_KEY}" \\
    exec docker run --rm -it \\
      --network "\${HAIVE_NETWORK:-\${HAIVE_INSTALL_ID:-haive}-network}" \\
      -v /var/run/docker.sock:/var/run/docker.sock \\
      -v "\${HAIVE_INSTALL_DIR_HOST}:/install" \\
      -e COMPOSE_PROJECT_NAME="\${COMPOSE_PROJECT_NAME:-\${HAIVE_INSTALL_ID:-haive}}" \\
      -e HAIVE_INSTALL_ID="\${HAIVE_INSTALL_ID:-haive}" \\
      -e DATABASE_URL \\
      -e REDIS_URL="redis://redis:6379" \\
      -e CONFIG_ENCRYPTION_KEY \\
${CHANNEL_UPGRADE_ENV}      "\${HAIVE_REGISTRY}/haive-updater:\${v#v}" \\
${MANIFEST_ARGS}      --install-dir /install \\
      --registry "\${HAIVE_REGISTRY}" \\
      --postgres-volume "\${COMPOSE_PROJECT_NAME:-\${HAIVE_INSTALL_ID:-haive}}_postgres_data" \\
      --snapshot-host-dir "\${HAIVE_INSTALL_DIR_HOST}/snapshots" "\$@"
    ;;
  *) echo "usage: ./haive up|down|logs|ps|version|upgrade --version <v>${CHANNEL_CHANGE_USAGE}" >&2; exit 2 ;;
esac
EOF
chmod +x haive

# Uninstall deliberately does NOT use `down -v`. Five volumes in docker-compose.yml carry an
# explicit global `name:` — haive_repos, haive_bundles, haive_wrappers, haive_squid_configs,
# haive_ddev_ca — so they are shared with any other Haive on this machine, and `-v` would take
# another install's cloned repositories with it. Only this project's own volumes are removed,
# and the shared ones are named so the choice is the operator's.
cat > uninstall.sh <<'EOF'
#!/bin/sh
#
# Remove THIS Haive install. Touches nothing that belongs to another install on this machine.
#
#   ./uninstall.sh              stack + this install's runtime data; your work is kept
#   ./uninstall.sh --purge      the above, plus repositories, credentials and built images
#   ./uninstall.sh --yes        skip the confirmation prompt
set -eu
cd "$(dirname "$0")"

PURGE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      echo "usage: ./uninstall.sh [--purge] [--yes]"
      echo "  --purge  also remove cloned repositories, CLI credentials and this install's images"
      echo "  --yes    do not prompt"
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

DC="docker compose -f docker-compose.yml -f docker-compose.run.yml"
ID="$(sed -n 's/^HAIVE_INSTALL_ID=//p' .env | head -1)"; : "${ID:=haive}"
PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env | head -1)"; : "${PROJECT:=$ID}"

# Runtime state: recreated from scratch on the next install. Losing it loses no work.
RUNTIME_VOLUMES="postgres_data redis_data mailpit_data ollama_data"
# Work: cloned repositories, uploaded bundles, CLI logins, the shared DDEV CA. Removed only
# under --purge, because "uninstall the app" and "delete my repositories" are different
# intentions and only one of them is reversible.
WORK_VOLUMES="repos bundles wrappers squid_configs ddev_ca npm_cache ddev_registry_cache"
# Image repositories this install BUILT. Enumerated, never matched with a `${ID}-*` wildcard:
# on the default id that glob also matches `haive-api`, `haive-worker` and `haive-web`, which is
# what a source checkout's compose build is called — so a wildcard purge would delete a
# developer's stack images from underneath them.
IMAGE_REPOS="${ID}-cli-sandbox ${ID}-sandbox ${ID}-ddev-runner"

# Without a daemon nothing can be removed, and nothing afterwards can be checked.
if ! docker info >/dev/null 2>&1; then
  echo "Cannot reach the Docker daemon, so nothing of the Haive install '${ID}' was removed." >&2
  echo "Start Docker, then run this again." >&2
  exit 1
fi

echo "Removing the Haive install '${ID}' (compose project ${PROJECT})."
if [ "$PURGE" -eq 1 ]; then
  echo "--purge: cloned repositories, CLI credentials and built images will ALSO be removed."
else
  echo "Your repositories and CLI logins will be KEPT. Re-run with --purge to remove them too."
fi
if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Type the install id to confirm: '
  read -r reply
  [ "$reply" = "$ID" ] || { echo "aborted."; exit 1; }
fi

# `down` first, so compose STOPS its own services rather than having them killed underneath it.
# The work volumes survive a default uninstall and a worker can be mid-write to one of them.
if ! $DC down; then
  echo "  docker compose down failed (see above); the check at the end lists what is left."
fi

# Containers the WORKER creates — per-task sandboxes, terminals, DDEV and app runners, the
# registry — are plain `docker run` and are NOT part of the compose project, so `down` neither
# stops them nor removes them. While one is attached the project network is still in use, which
# is why `down` reports "resource is still in use" and leaves the network behind.
swept=0
for c in $(docker ps -aq --filter "name=^${ID}-" 2>/dev/null); do
  if docker rm -f "$c" >/dev/null 2>&1; then swept=$((swept + 1)); fi
done
[ "$swept" -gt 0 ] && echo "  removed ${swept} container(s) outside the compose project"

# Now nothing THIS install owns holds them. A network that is already gone is a silent no-op, but
# one that REFUSES is reported: something outside this install is still attached to it, and the
# closing "everything is gone" line would otherwise be a lie. MEASURED — a container created
# outside the install kept its network alive through a --purge that claimed success.
for n in $(docker network ls -q --filter "name=^${ID}-" 2>/dev/null); do
  name=$(docker network inspect "$n" --format '{{.Name}}' 2>/dev/null || printf '%s' "$n")
  if docker network rm "$n" >/dev/null 2>&1; then
    echo "  removed network ${name}"
  else
    attached=$(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || true)
    echo "  COULD NOT remove network ${name} — still attached: ${attached:-unknown}"
  fi
done

# rm fails the same way for an absent volume and a held one, so only a volume that exists is tried.
remove_volume() {
  docker volume inspect "$1" >/dev/null 2>&1 || return 0
  if docker volume rm "$1" >/dev/null 2>&1; then
    echo "  removed $1"
  else
    holders=$(docker ps -a --filter "volume=$1" --format '{{.Names}}' 2>/dev/null | paste -sd, -)
    echo "  COULD NOT remove volume $1 — held by: ${holders:-no container listed}"
  fi
}

for v in $RUNTIME_VOLUMES; do
  remove_volume "${PROJECT}_${v}"
done

if [ "$PURGE" -eq 1 ]; then
  for v in $WORK_VOLUMES; do
    remove_volume "${ID}_${v}"
  done
  # Per-task auth and IDE volumes are created at runtime, so they are found rather than listed.
  for v in $(docker volume ls -q --filter "name=^${ID}_cli_auth_" 2>/dev/null) \
           $(docker volume ls -q --filter "name=^${ID}_ide_" 2>/dev/null); do
    remove_volume "$v"
  done
  for repo in $IMAGE_REPOS; do
    for img in $(docker images -q "$repo" 2>/dev/null | sort -u); do
      if docker rmi -f "$img" >/dev/null 2>&1; then echo "  removed image $repo"; fi
    done
  done
  # Replicated environments are `<id>-env-<slug>`, one repository per project, so they are
  # matched on the prefix rather than enumerated.
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep "^${ID}-env-" || true); do
    if docker rmi -f "$img" >/dev/null 2>&1; then echo "  removed image $img"; fi
  done
else
  echo ""
  echo "Kept, because it holds your work rather than this install's runtime state:"
  if ! docker info >/dev/null 2>&1; then
    echo "  (unknown: Docker stopped answering, so the volumes could not be listed)"
  else
    kept=0
    for v in $WORK_VOLUMES; do
      docker volume inspect "${ID}_${v}" >/dev/null 2>&1 && { echo "  ${ID}_${v}"; kept=$((kept + 1)); }
    done
    for v in $(docker volume ls -q --filter "name=^${ID}_cli_auth_" 2>/dev/null) \
             $(docker volume ls -q --filter "name=^${ID}_ide_" 2>/dev/null); do
      echo "  $v"; kept=$((kept + 1))
    done
    [ "$kept" -eq 0 ] && echo "  (nothing — this install never cloned a repository or logged a CLI in)"
  fi
  echo ""
  echo "To remove those too, re-run:  ./uninstall.sh --purge"
fi

# One final look decides the closing message and the exit status; a listing that fails is "unknown", not empty.
left=""
unchecked=0
shown=0
add() {
  left="${left}$1 $2
"
}

removes_volume() {
  for k in $RUNTIME_VOLUMES; do if [ "$1" = "${PROJECT}_${k}" ]; then return 0; fi; done
  if [ "$PURGE" -eq 0 ]; then return 1; fi
  for k in $WORK_VOLUMES; do if [ "$1" = "${ID}_${k}" ]; then return 0; fi; done
  case "$1" in "${ID}_cli_auth_"* | "${ID}_ide_"*) return 0 ;; esac
  return 1
}

removes_image() {
  case " $IMAGE_REPOS " in *" ${1%:*} "*) return 0 ;; esac
  case "$1" in "${ID}-env-"*) return 0 ;; esac
  return 1
}

show_left() {
  names=""
  for n in $(printf '%s' "$left" | sed -n "s/^$1 //p" | sort -u); do names="${names:+$names }$n"; done
  if [ -n "$names" ]; then
    if [ "$shown" -eq 0 ]; then echo "Still here, so this is NOT a clean uninstall:"; fi
    shown=1
    echo "  $2"
    echo "    $3 $names"
  fi
}

listing=$(docker ps -a --filter "name=^${ID}-" --format '{{.Names}}' 2>/dev/null) || unchecked=1
for c in $listing; do add container "$c"; done
listing=$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}' 2>/dev/null) || unchecked=1
for c in $listing; do add container "$c"; done
listing=$(docker network ls --filter "name=^${ID}-" --format '{{.Name}}' 2>/dev/null) || unchecked=1
for n in $listing; do add network "$n"; done
listing=$(docker volume ls -q 2>/dev/null) || unchecked=1
for v in $listing; do if removes_volume "$v"; then add volume "$v"; fi; done
if [ "$PURGE" -eq 1 ]; then
  listing=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null) || unchecked=1
  for img in $listing; do if removes_image "$img"; then add image "$img"; fi; done
fi

echo ""
show_left container containers "docker rm -f"
show_left network networks "docker network rm"
show_left volume volumes "docker volume rm"
show_left image images "docker rmi -f"
if [ "$unchecked" -eq 1 ]; then
  echo "Docker stopped answering while this was checked, so more than the above may be left."
fi
if [ "$shown" -eq 1 ] || [ "$unchecked" -eq 1 ]; then
  echo "Once that is dealt with, run this again with the same options to confirm."
  exit 1
fi

if [ "$PURGE" -eq 1 ]; then
  echo "Everything this install owned is gone."
  echo "Delete this directory to finish:"
  echo "  rm -rf $(pwd)"
else
  echo "The stack is gone either way; delete this directory when you are done with it."
fi
EOF
if [ "$CHANNEL" != "public" ]; then
  # Match a literal generated comment; its backticks must not run in the installer.
  # shellcheck disable=SC2016
  sed '/^set -eu/a\
unset HAIVE_REGISTRY_TOKEN
/^# `down` first/i\
rm -rf .docker
' uninstall.sh > "$CHANNEL_SCRATCH/uninstall.sh"
  mv "$CHANNEL_SCRATCH/uninstall.sh" uninstall.sh
fi
chmod +x uninstall.sh
say "  helpers           ./haive, ./uninstall.sh"

if [ "$NO_START" -eq 1 ]; then
  say ""
  say "--no-start: written but not booted. Start it with:  cd $INSTALL_DIR && ./haive up"
  exit 0
fi

step "Pulling images (this is the slow part)"
# A pull failure is FATAL and named. It used to be swallowed by `|| true`, which turned the single
# most likely failure on a slow or flaky network — the step whose own banner calls it the slow part
# — into an install that wrote itself and then simply never came up, with nothing said about why.
# install.ps1 has always failed loudly here; this is the sh side catching up.
#
# The old noise filter went with it: `pull` streams into a pipeline, and a pipeline's status is the
# LAST command's, so keeping `| grep -v …` means reading grep's answer and not docker's. (That grep
# was also GNU-only — BSD grep reads `\|` as a literal, so on macOS it filtered nothing at all.)
# `--quiet` is what suppresses the progress bars; the filter was only trimming what it left behind.
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES pull --quiet || die "could not pull the images.
       Check your network, then retry — the install itself is written and complete:
         cd $INSTALL_DIR && ./haive up"

step "Starting Haive"
# The install directory is COMPLETE by now, so a boot failure is a retry rather than a reinstall —
# and saying so is the difference between a one-line fix and reverse-engineering the compose
# invocation. REPORTED from a macOS arm64 install: the stack did not start, and its owner worked
# out `docker compose -f docker-compose.yml -f docker-compose.run.yml up` by hand rather than
# running the `./haive up` that was sitting beside it.
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up -d || die "the stack did not start.
       The install is written and complete, so this is a retry, not a reinstall:
         cd $INSTALL_DIR && ./haive up
       And to see why it failed:
         cd $INSTALL_DIR && ./haive logs"

step "Waiting for the API"
# 6 minutes, not 4. A FIRST boot initialises the Postgres data directory and applies the whole
# baseline before the api can answer, and it does that on a machine that has just finished pulling
# several images — so the budget has to cover the slowest legitimate start, not the typical one.
# The periodic note is not decoration: without it a silent multi-minute wait is indistinguishable
# from a hang, which is what makes someone kill the installer on a stack that was about to come up.
PORT=$(sed -n 's/^HAIVE_API_PORT=//p' .env | head -1); : "${PORT:=3001}"
i=1
while [ "$i" -le 180 ]; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    say "  api               healthy"
    break
  fi
  # The containers are already up; this is the api's own startup. Say the elapsed time so the wait
  # reads as progress.
  [ "$((i % 15))" -ne 0 ] || say "  waiting           $((i * 2))s — a first boot initialises the database"
  [ "$i" -lt 180 ] || die "the API did not answer within 6 minutes.
       The containers ARE running: the start step above succeeded, so this is a slow or stuck
       start rather than a failed install. Watch it:
         cd $INSTALL_DIR && ./haive logs api
       And once it answers, open http://localhost:$(sed -n 's/^HAIVE_WEB_PORT=//p' .env | head -1)."
  sleep 2
  i=$((i + 1))
done

WEB=$(sed -n 's/^HAIVE_WEB_PORT=//p' .env | head -1); : "${WEB:=3000}"
cat <<EOF

  Haive ${PINNED} is running.

    Web       http://localhost:${WEB}
    API       http://localhost:${PORT}
    Mail      http://localhost:$(sed -n 's/^HAIVE_MAILPIT_PORT=//p' .env | head -1)
    Directory ${INSTALL_DIR}
    Install   ${INSTALL_ID}

  Manage it with ./haive up|down|logs|ps|version|upgrade, and remove it with ./uninstall.sh.

  One thing you should know before you use it:

    The Haive worker mounts the Docker socket, so it can create and destroy containers on
    this machine. That is how it runs AI CLIs in sandboxes — and it is equivalent to root
    on the host. Run Haive on a machine where that is acceptable. Rootless Docker is the
    alternative and is documented in the README.

EOF
