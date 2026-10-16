#!/usr/bin/env bash
# Smoke for registry-module images: installing a module from a private npm registry in the api,
# worker and web image builds, without the registry's token ever reaching an image.
#
#   flock -w 1800 /tmp/haive-full-suite.lock bash scripts/module-dist-smoke.sh
#
# It tests HEAD (`git archive`), never the checkout: commit first. It needs docker, node, pnpm and
# network for the base images and npm. It runs one throwaway container on an ephemeral 127.0.0.1
# port, builds images named haive-smoke-*, and removes exactly those and its temp dir on the way
# out; it never prunes and never touches the dev stack.
#
# Every step prints PASS or FAIL with its id. Exit 0: nothing failed. 1: a step failed. 2: the
# smoke could not run (no docker, no route from a build to the registry, disk below the limit).
# HAIVE_SMOKE_STEPS="5 6" runs only those steps; HAIVE_SMOKE_LOG_DIR keeps the build logs.
#
#   1  api and worker production builds, and the web, api and worker deps stages (what the dev
#      compose builds), install @haive-module/smokefix with the npmrc build secret; the generated
#      module list in each production image names it
#   2  the token is in no image, deps stages included: history, inspect, every layer of docker
#      save, and no build log; a CONTROL image that leaks it on purpose is found by the same scan
#   3  with the token revoked, a rebuild without the cache fails with the registry's 401 and the
#      image from step 1 is untouched
#   4  a tree with no registry module and no secret still builds, with no env-replace warning;
#      no .npmrc in HEAD holds a credential
#   5  docker compose config renders with and without HAIVE_NPMRC, and with it carries the secret
#   6  a module folder's .git is not in the api build context; 6b neither is a nested .npmrc or
#      .env (under modules/<id>/ or packages/), while the root .npmrc still is
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SMOKE=$ROOT/scripts/smoke
FIXTURE=$ROOT/tests/fixtures/registry-module

REGISTRY=haive-smoke-npm
NODE_IMAGE=node:26-bookworm-slim
IMAGES=(
  haive-smoke-api:ok haive-smoke-worker:ok haive-smoke-web:deps haive-smoke-api:deps
  haive-smoke-worker:deps haive-smoke-api:zero
  haive-smoke-control:leak haive-smoke-probe:net
)
STEPS=${HAIVE_SMOKE_STEPS:-"1 2 3 4 5 6"}
BUILD_TIMEOUT=${HAIVE_SMOKE_BUILD_TIMEOUT:-1800}
MIN_FREE_GB=${HAIVE_SMOKE_MIN_FREE_GB:-15}

SERVED='GET /@haive-module/smokefix/-/smokefix-0.1.0.tgz 200 auth=ok'
# VOLATILE: pnpm's own words, from the brief and from pnpm 10. Step 4b fails, never passes, when the
# install line is missing from the log, so a rewording shows up as a FAIL and not as a quiet PASS.
PNPM_ENV_WARNING='Failed to replace env in config'
PNPM_INSTALL_DONE='Done in .* using pnpm'

PASSED=()
FAILED=()
PORT=
REG_HOST=
BUILD_NET=()
BUILD_PID=
SETUP_ERROR=

pass() {
  printf 'PASS  %-3s %s\n' "$1" "$2"
  PASSED+=("$1")
}
fail() {
  printf 'FAIL  %-3s %s\n' "$1" "$2"
  FAILED+=("$1")
}
say() { printf '      %s\n' "$*"; }
section() { printf '      == %s [+%ss]\n' "$*" "$SECONDS"; }
indent() { sed 's/^/        /'; }
abort() {
  printf 'SETUP FAILED: %s\n' "$*"
  exit 2
}
want() { [[ " $STEPS " == *" $1 "* ]]; }
token() { printf 'smoketok-%s' "$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"; }

remove_artifacts() {
  docker rm -f "$REGISTRY" >/dev/null 2>&1
  local image
  for image in "${IMAGES[@]}"; do docker image rm -f "$image" >/dev/null 2>&1; done
}

cleanup() {
  local code=$?
  trap - EXIT
  [[ -z "$BUILD_PID" ]] || kill "$BUILD_PID" 2>/dev/null
  remove_artifacts
  if [[ -n "${TMP:-}" && "$TMP" == */haive-module-smoke.* ]]; then rm -rf "$TMP"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_gb() { df -BG --output=avail /mnt/c | tail -n 1 | tr -dc '0-9'; }

check_disk() {
  [[ -d /mnt/c ]] || return 0
  local free
  free=$(free_gb)
  [[ ${free:-0} -ge $MIN_FREE_GB ]] ||
    abort "only ${free:-?} GB free on C: (limit $MIN_FREE_GB GB, HAIVE_SMOKE_MIN_FREE_GB)"
}

http_ok() {
  node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$1"
}

docker_build() {
  local log=$1 code
  shift
  check_disk
  timeout "$BUILD_TIMEOUT" docker build --progress=plain "$@" >"$log" 2>&1 </dev/null &
  BUILD_PID=$!
  wait "$BUILD_PID"
  code=$?
  BUILD_PID=
  return "$code"
}

export_tree() {
  mkdir -p "$1" && git -C "$ROOT" archive HEAD | tar -x -C "$1"
}

registry_lines() { docker logs "$REGISTRY" 2>&1 | wc -l; }
registry_since() { docker logs "$REGISTRY" 2>&1 | tail -n +"$(($1 + 1))"; }
registry_saw() {
  local lines
  lines=$(registry_since "$1")
  grep -q -- "$2" <<<"$lines"
}

show_failure() {
  local log=$1 mark=$2 found
  found=$(grep -E 'ERR_PNPM|Unauthorized|[^0-9]401[^0-9]' "$log" | sed -E 's/^(#[0-9]+ )?[0-9.]+ +//' | awk '!seen[$0]++' | head -n 4)
  [[ -z "$found" ]] || { say "build log:"; printf '%s\n' "$found" | indent; }
  found=$(registry_since "$mark" | grep -E ' (401|404) ' | head -n 4)
  [[ -z "$found" ]] || { say "registry saw:"; printf '%s\n' "$found" | indent; }
  if registry_saw "$mark" ' 401 auth=none'; then
    say "diagnosis: a request reached the registry with no Authorization header, so pnpm install ran without the npmrc secret"
  fi
  say "end of $log:"
  tail -n 12 "$log" | indent
}

start_registry() {
  if docker inspect "$REGISTRY" >/dev/null 2>&1; then
    say "registry log of the container being replaced:"
    docker logs "$REGISTRY" 2>&1 | indent
    docker rm -f "$REGISTRY" >/dev/null || return 1
  fi
  local attempt _
  for attempt in $(seq 1 10); do
    docker run -d --name "$REGISTRY" -p "127.0.0.1:${2}:4873" -v "$REG_DIR:/srv:ro" \
      -e "FAKE_NPM_TOKEN=$1" "$NODE_IMAGE" node /srv/fake-npm-registry.mjs /srv/tarballs 4873 \
      >/dev/null 2>&1 && break
    docker rm -f "$REGISTRY" >/dev/null 2>&1
    [[ $attempt -lt 10 ]] || return 1
    sleep 1
  done
  PORT=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "4873/tcp") 0).HostPort}}' "$REGISTRY")
  for _ in $(seq 1 30); do
    http_ok "http://127.0.0.1:$PORT/-/ping" && return 0
    sleep 1
  done
  docker logs "$REGISTRY" 2>&1 | indent
  return 1
}

# A build is not the host: on Docker Desktop its 127.0.0.1 is the engine VM's, which holds no
# published port. Take the first route that a build really reaches, and use it from here on.
prove_build_route() {
  local dir=$TMP/probe route net host
  mkdir -p "$dir"
  printf 'FROM %s\nARG URL\nRUN node -e "fetch(process.env.URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"\n' \
    "$NODE_IMAGE" >"$dir/Dockerfile"
  for route in host:127.0.0.1 host:host.docker.internal default:host.docker.internal; do
    net=${route%%:*}
    host=${route#*:}
    BUILD_NET=()
    [[ $net == host ]] && BUILD_NET=(--network host)
    if docker_build "$LOG_DIR/probe-$net-$host.log" --no-cache "${BUILD_NET[@]}" \
      --build-arg "URL=http://$host:$PORT/-/ping" -t haive-smoke-probe:net "$dir"; then
      REG_HOST=$host
      say "a $net-network build reaches the registry at $host:$PORT (GET /-/ping)"
      return 0
    fi
    say "a $net-network build cannot reach $host:$PORT"
  done
  return 1
}

write_scope_line() {
  { grep -v '^@haive-module:registry=' "$TREE/.npmrc"; printf '@haive-module:registry=http://%s:%s/\n' "$1" "$PORT"; } \
    >"$TREE/.npmrc.new" && mv "$TREE/.npmrc.new" "$TREE/.npmrc"
}

setup() {
  mkdir -p "$REG_DIR/tarballs" "$LOG_DIR"
  cp "$SMOKE/fake-npm-registry.mjs" "$REG_DIR/"
  cp -R "$FIXTURE" "$TMP/fixture" || abort "could not copy the fixture"
  cp -R "$TMP/fixture/src" "$TMP/fixture/dist" || abort "could not build the fixture's dist"
  (cd "$TMP/fixture" && CI=true pnpm pack --pack-destination "$REG_DIR/tarballs" >/dev/null) ||
    abort "pnpm pack of tests/fixtures/registry-module failed"
  start_registry "$T1" "" || abort "the fake registry did not start"
  say "fake registry $REGISTRY on 127.0.0.1:$PORT serves @haive-module/smokefix@0.1.0 to one token"
  prove_build_route || abort "no build route reaches the registry (see $LOG_DIR/probe-*.log)"

  export_tree "$TREE" || abort "git archive of HEAD failed"
  node -e '
    const fs = require("node:fs");
    for (const file of process.argv.slice(1)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.dependencies["@haive-module/smokefix"] = "0.1.0";
      pkg.dependencies = Object.fromEntries(
        Object.entries(pkg.dependencies).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    }' "$TREE/packages/api/package.json" "$TREE/packages/worker/package.json" ||
    abort "could not add @haive-module/smokefix to the api and worker package.json"
  {
    printf '//127.0.0.1:%s/:_authToken=%s\n' "$PORT" "$T1"
    [[ $REG_HOST == 127.0.0.1 ]] || printf '//%s:%s/:_authToken=%s\n' "$REG_HOST" "$PORT" "$T1"
  } >"$TMP/npmrc"
  chmod 600 "$TMP/npmrc"
  write_scope_line 127.0.0.1
  (cd "$TREE" && CI=true XDG_CACHE_HOME="$TMP/cache" NPM_CONFIG_USERCONFIG="$TMP/npmrc" \
    pnpm install --lockfile-only >"$LOG_DIR/lockfile.log" 2>&1) ||
    { tail -n 15 "$LOG_DIR/lockfile.log" | indent; SETUP_ERROR="pnpm install --lockfile-only failed in the tree under test"; return 1; }
  grep -q "^  '@haive-module/smokefix@0.1.0':" "$TREE/pnpm-lock.yaml" ||
    { SETUP_ERROR="the lockfile of the tree under test does not hold @haive-module/smokefix@0.1.0"; return 1; }
  write_scope_line "$REG_HOST"
  say "tree from git archive HEAD: smokefix 0.1.0 locked in api and worker; scope line -> $REG_HOST:$PORT; token only in the secret file"
}

build_module_image() {
  local svc=$1 id=$2 log=$LOG_DIR/1-$1.log mark
  mark=$(registry_lines)
  if ! docker_build "$log" --target production "${BUILD_NET[@]}" \
    --secret "id=npmrc,src=$TMP/npmrc" --no-cache-filter deps \
    -f "$TREE/packages/$svc/Dockerfile" -t "haive-smoke-$svc:ok" "$TREE"; then
    fail "$id" "haive-smoke-$svc:ok did not build with the npmrc secret"
    show_failure "$log" "$mark"
    return
  fi
  if ! registry_saw "$mark" "$SERVED"; then
    fail "$id" "haive-smoke-$svc:ok built, but the registry never served the tarball to the build"
    return
  fi
  pass "$id" "haive-smoke-$svc:ok built; the registry served smokefix-0.1.0.tgz to the secret's token"
}

build_deps_image() {
  local svc=$1 id=$2 log=$LOG_DIR/1-$1-deps.log mark
  mark=$(registry_lines)
  if ! docker_build "$log" --target deps "${BUILD_NET[@]}" \
    --secret "id=npmrc,src=$TMP/npmrc" --no-cache-filter deps \
    -f "$TREE/packages/$svc/Dockerfile" -t "haive-smoke-$svc:deps" "$TREE"; then
    fail "$id" "haive-smoke-$svc:deps ($svc deps stage) did not build with the npmrc secret"
    show_failure "$log" "$mark"
    return
  fi
  if ! registry_saw "$mark" "$SERVED"; then
    fail "$id" "haive-smoke-$svc:deps built, but the registry never served the tarball to the build"
    return
  fi
  pass "$id" "haive-smoke-$svc:deps built; the registry served smokefix-0.1.0.tgz to the secret's token"
}

check_generated_list() {
  local svc=$1 id=$2 out
  if ! docker image inspect "haive-smoke-$svc:ok" >/dev/null 2>&1; then
    fail "$id" "haive-smoke-$svc:ok does not exist, so its module list cannot be read"
    return
  fi
  if out=$(timeout 300 docker run --rm -i -w "/app/packages/$svc" \
    -e "CHECK_FILE=/app/packages/$svc/dist/modules.generated.js" \
    -e CHECK_PACKAGE=@haive-module/smokefix \
    "haive-smoke-$svc:ok" node --input-type=module - <"$SMOKE/check-registry-list.mjs" 2>&1); then
    pass "$id" "$svc: $out"
  else
    fail "$id" "$svc: the generated module list does not name @haive-module/smokefix as the loaders need"
    printf '%s\n' "$out" | indent
  fi
}

step1() {
  section "1. the secret reaches pnpm install in the api, worker and web builds"
  build_module_image api 1a
  build_module_image worker 1b
  check_generated_list api 1c
  check_generated_list worker 1d
  build_deps_image web 1e
  build_deps_image api 1f
  build_deps_image worker 1g
}

scan() {
  local image=$1 id=$2 label=$3 out code
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    fail "$id" "$label: $image does not exist, so nothing could be scanned"
    return
  fi
  out=$(SCAN_TOKEN=$T1 TMPDIR=$TMP "$SMOKE/scan-image.sh" "$image" 2>&1)
  code=$?
  case $code in
    0) pass "$id" "$label: the token is in no history, inspect or layer ($out)" ;;
    1) fail "$id" "$label: the token is in the image ($out)" ;;
    *) fail "$id" "$label: the scan could not run: $out" ;;
  esac
}

scan_control() {
  local dir=$TMP/control out code place missed=()
  mkdir -p "$dir"
  cat >"$dir/Dockerfile" <<EOF
FROM $NODE_IMAGE
ARG LEAK
ENV LEAK_ENV=\$LEAK
LABEL smoke.leak=\$LEAK
RUN printf '//registry.invalid/:_authToken=%s\\n' "\$LEAK" > /root/.npmrc
EOF
  if ! docker_build "$LOG_DIR/control.log" --build-arg "LEAK=$T1" -t haive-smoke-control:leak "$dir"; then
    fail 2d "CONTROL: the leaking image did not build"
    tail -n 12 "$LOG_DIR/control.log" | indent
    return
  fi
  out=$(SCAN_TOKEN=$T1 TMPDIR=$TMP "$SMOKE/scan-image.sh" haive-smoke-control:leak 2>&1)
  code=$?
  for place in history inspect config layers; do
    [[ "$(sed -n "s/.*$place=\([0-9]*\).*/\1/p" <<<"$out")" -gt 0 ]] 2>/dev/null || missed+=("$place")
  done
  if [[ $code -eq 1 && ${#missed[@]} -eq 0 ]]; then
    pass 2d "CONTROL: the scan finds the token a build arg wrote into an image, in every place ($out)"
  else
    fail 2d "CONTROL: the scan missed a deliberate leak (exit $code, blind in: ${missed[*]:-none}; $out)"
  fi
}

scan_logs() {
  section "2e. the token is in no build log of any step"
  local log token n scanned=0 count=0
  for log in "$LOG_DIR"/*.log; do
    [[ -f "$log" && "$log" != */control.log ]] || continue
    for token in "$T1" "$T2" "$T3" "$T4"; do
      if ! n=$(SCAN_TOKEN=$token node "$SMOKE/count-token.mjs" <"$log"); then
        fail 2e "a token count could not be taken from $log"
        return
      fi
      count=$((count + n))
    done
    scanned=$((scanned + 1))
  done
  if [[ $scanned -eq 0 ]]; then
    fail 2e "there was no build log to scan"
  elif [[ $count -ne 0 ]]; then
    fail 2e "$count token occurrence(s) in the $scanned build logs of this run"
  else
    pass 2e "no token in the $scanned build logs of this run (the control's is left out: it leaks on purpose)"
  fi
}

step2() {
  section "2. the token is in no image"
  scan haive-smoke-api:ok 2a api
  scan haive-smoke-worker:ok 2b worker
  scan haive-smoke-web:deps 2c web-deps
  scan haive-smoke-api:deps 2f api-deps
  scan haive-smoke-worker:deps 2g worker-deps
  scan_control
}

step3() {
  section "3. a revoked token fails the rebuild and leaves the previous image alone"
  local before after log=$LOG_DIR/3-api.log mark=0 code=0 problems=()
  before=$(docker image inspect -f '{{.Id}}' haive-smoke-api:ok 2>/dev/null)
  if ! start_registry "$T2" "$PORT"; then
    fail 3a "could not restart the registry with a different token"
    fail 3b "the rebuild was not attempted"
    return
  fi
  say "registry restarted on 127.0.0.1:$PORT with another token; the secret file still holds the old one"
  docker_build "$log" --target production "${BUILD_NET[@]}" --secret "id=npmrc,src=$TMP/npmrc" \
    --no-cache-filter deps -f "$TREE/packages/api/Dockerfile" -t haive-smoke-api:ok "$TREE" || code=$?
  [[ $code -ne 0 ]] || problems+=("the rebuild succeeded")
  grep '@haive-module/smokefix' "$log" | grep -qE 'ERR_PNPM_FETCH_401|[^0-9]401([^0-9]|$)' ||
    problems+=("no line of the build log names a 401 (ERR_PNPM_FETCH_401) for @haive-module/smokefix")
  registry_saw "$mark" ' 401 auth=bad' ||
    problems+=("the registry saw no request carrying the revoked token (401 auth=bad): the install did not use the secret")
  if [[ ${#problems[@]} -eq 0 ]]; then
    pass 3a "the rebuild exited $code with ERR_PNPM_FETCH_401 for smokefix, from a request carrying the revoked token"
  else
    fail 3a "the revoked-token rebuild is not the failure it should be"
    printf '%s\n' "${problems[@]}" | indent
    show_failure "$log" "$mark"
  fi

  after=$(docker image inspect -f '{{.Id}}' haive-smoke-api:ok 2>/dev/null)
  if [[ -z "$before" ]]; then
    fail 3b "haive-smoke-api:ok did not exist before the rebuild (step 1a failed): nothing to keep"
  elif [[ "$before" != "$after" ]]; then
    fail 3b "haive-smoke-api:ok changed from $before to ${after:-<gone>}"
  elif ! timeout 120 docker run --rm haive-smoke-api:ok node -e 'process.exit(0)'; then
    fail 3b "haive-smoke-api:ok kept its id but no longer runs"
  else
    pass 3b "haive-smoke-api:ok kept its image id ($before) and still runs"
  fi
}

# file:line of every .npmrc line under $1 that carries a credential; never the line itself
npmrc_credentials() {
  find "$1" -name .npmrc -exec awk '
    /^[ \t]*[#;]/ { next }
    /(^|:)_(auth|authToken|password)[ \t]*=/ || /:\/\/[^\/@ \t]*:[^\/@ \t]*@/ { print FILENAME ":" FNR }
  ' {} + | sed "s|^$1/||"
}

step4() {
  section "4. no registry module, no secret: the api image builds and pnpm warns of nothing"
  local log=$LOG_DIR/4-api.log credentials
  export_tree "$TMP/tree-zero" || abort "git archive of HEAD failed"
  if docker_build "$log" --target production --no-cache-filter deps \
    -f "$TMP/tree-zero/packages/api/Dockerfile" -t haive-smoke-api:zero "$TMP/tree-zero"; then
    pass 4a "haive-smoke-api:zero built from HEAD with no secret"
    if ! grep -qE "$PNPM_INSTALL_DONE" "$log"; then
      fail 4b "pnpm install did not run in that build, so its warnings were not looked at"
    elif grep -q "$PNPM_ENV_WARNING" "$log"; then
      fail 4b "the build log has a '$PNPM_ENV_WARNING' warning"
      grep "$PNPM_ENV_WARNING" "$log" | head -n 3 | indent
    else
      pass 4b "pnpm install ran and warned of no unset env variable in .npmrc"
    fi
  else
    fail 4a "the production api image of a tree without registry modules did not build"
    fail 4b "not evaluated: 4a failed, so there is no install log to read"
    show_failure "$log" 0
  fi
  credentials=$(npmrc_credentials "$TMP/tree-zero")
  if [[ -z "$credentials" ]]; then
    pass 4c "no .npmrc in HEAD sets _auth, _authToken or _password, or puts user:password in a URL"
  else
    fail 4c "an .npmrc in HEAD carries a credential line (file:line; the values are not printed)"
    printf '%s\n' "$credentials" | indent
  fi
}

step5() {
  section "5. docker compose config, with and without HAIVE_NPMRC"
  local tree=$TMP/tree-compose file=$TMP/compose-npmrc out
  export_tree "$tree" || abort "git archive of HEAD failed"
  printf '//registry.invalid/:_authToken=not-a-token\n' >"$file"
  local compose=(docker compose --project-directory "$tree" -f "$tree/docker-compose.yml" -f "$tree/docker-compose.dev.yml")
  if env -u HAIVE_NPMRC "${compose[@]}" config >/dev/null 2>"$LOG_DIR/5-without.err"; then
    pass 5a "config renders without HAIVE_NPMRC"
  else
    fail 5a "config exits non-zero without HAIVE_NPMRC"
    tail -n 6 "$LOG_DIR/5-without.err" | indent
  fi
  if HAIVE_NPMRC=$file "${compose[@]}" config --format json >"$TMP/compose.json" 2>"$LOG_DIR/5-with.err"; then
    pass 5b "config renders with HAIVE_NPMRC set"
  else
    fail 5b "config exits non-zero with HAIVE_NPMRC set"
    tail -n 6 "$LOG_DIR/5-with.err" | indent
    fail 5c "not evaluated: 5b failed, so there is no rendered config to read"
    fail 5d "not evaluated: 5b failed, so there is no rendered config to read"
    return
  fi
  if out=$(node "$SMOKE/check-compose.mjs" "$file" secrets <"$TMP/compose.json"); then
    pass 5c "api, worker, web and dev-libs carry the npmrc build secret, sourced from HAIVE_NPMRC"
  else
    fail 5c "the rendered config does not give the dev builds the npmrc secret"
    printf '%s\n' "$out" | indent
  fi
  if out=$(node "$SMOKE/check-compose.mjs" "$file" mount <"$TMP/compose.json"); then
    pass 5d "db-migrate mounts HAIVE_NPMRC read-only where pnpm reads it"
  else
    fail 5d "the rendered config does not give db-migrate's runtime pnpm install the npmrc"
    printf '%s\n' "$out" | indent
  fi
}

step6() {
  section "6. a module folder's .git is not in the api build context"
  local tree=$TMP/tree-git dump=$TMP/context-dump found leaked
  export_tree "$tree" || abort "git archive of HEAD failed"
  mkdir -p "$tree/modules/gitfix/.git"
  printf '{"name":"@haive/module-gitfix","version":"0.0.0","private":true}\n' >"$tree/modules/gitfix/package.json"
  printf '[remote "origin"]\n\turl = https://oauth2:%s@git.invalid/acme/gitfix.git\n' "$T3" >"$tree/modules/gitfix/.git/config"
  printf '//npm.pkg.github.com/:_authToken=%s\n' "$T4" >"$tree/modules/gitfix/.npmrc"
  printf 'GITFIX_TOKEN=%s\n' "$T4" >"$tree/modules/gitfix/.env"
  printf 'WEB_TOKEN=%s\n' "$T4" >"$tree/packages/web/.env.production"
  printf 'FROM scratch AS smoke-context-dump\nCOPY . /\n' >>"$tree/packages/api/Dockerfile"
  if ! docker_build "$LOG_DIR/6-context.log" --target smoke-context-dump --output "type=local,dest=$dump" \
    -f "$tree/packages/api/Dockerfile" "$tree"; then
    fail 6 "the context of the api build could not be dumped"
    tail -n 12 "$LOG_DIR/6-context.log" | indent
    return
  fi
  if [[ ! -f "$dump/modules/gitfix/package.json" ]]; then
    fail 6 "modules/gitfix is not in the dumped context at all, so the dump says nothing about its .git"
    return
  fi
  found=$(find "$dump/modules" -name .git | head -n 3)
  leaked=$(tar -C "$dump" -cf - . | SCAN_TOKEN=$T3 node "$SMOKE/count-token.mjs") || leaked=unknown
  if [[ -n "$found" || "$leaked" != 0 ]]; then
    fail 6 "modules/gitfix/.git, with a token in its remote URL, is in the api build context (.dockerignore excludes only the root .git)"
    [[ -z "$found" ]] || printf '%s\n' "$found" | sed "s|^$dump/|        |"
  else
    pass 6 "modules/gitfix is in the context, its .git is not, and no token is in it"
  fi
  local nested
  nested=$(cd "$dump" && find . -mindepth 2 \( -name .npmrc -o -name .env -o -name '.env.*' \) | head -n 5)
  leaked=$(tar -C "$dump" -cf - . | SCAN_TOKEN=$T4 node "$SMOKE/count-token.mjs") || leaked=unknown
  if [[ ! -f "$dump/.npmrc" ]]; then
    fail 6b "the root .npmrc is not in the api build context, so the scope line cannot reach the install"
  elif [[ -n "$nested" || "$leaked" != 0 ]]; then
    fail 6b "a nested .npmrc or .env holding a token is in the api build context (.dockerignore excludes .env files only at the root and names no .npmrc)"
    [[ -z "$nested" ]] || printf '%s\n' "$nested" | indent
  else
    pass 6b "no nested .npmrc or .env is in the api build context, and the root .npmrc is"
  fi
}

blocked() {
  local id
  for id in "$@"; do fail "$id" "not run: $SETUP_ERROR"; done
}

main() {
  local step ran=0
  for step in 1 2 3 4 5 6; do want "$step" && ran=1; done
  [[ $ran -eq 1 ]] || abort "HAIVE_SMOKE_STEPS names no step; use some of 1 2 3 4 5 6"
  preflight
  if want 1 || want 2 || want 3; then
    section "setup"
    setup
  fi
  if [[ -z "$SETUP_ERROR" ]]; then
    want 1 && step1
    want 2 && step2
    want 3 && step3
  else
    want 1 && blocked 1a 1b 1c 1d 1e 1f 1g
    want 2 && blocked 2a 2b 2c 2d 2e 2f 2g
    want 3 && blocked 3a 3b
  fi
  want 4 && step4
  want 5 && step5
  want 6 && step6
  if want 2 && [[ -z "$SETUP_ERROR" ]]; then scan_logs; fi

  echo
  if docker inspect "$REGISTRY" >/dev/null 2>&1; then
    section "registry log of the last container"
    docker logs "$REGISTRY" 2>&1 | indent
  fi
  docker system df | indent
  [[ ! -d /mnt/c ]] || say "C: free after: $(free_gb) GB"
  echo "== summary: ${#PASSED[@]} passed${PASSED[*]:+ (${PASSED[*]})}, ${#FAILED[@]} failed${FAILED[*]:+ (${FAILED[*]})}, $SECONDS s"
  [[ ${#FAILED[@]} -eq 0 ]]
}

preflight() {
  docker info >/dev/null 2>&1 || abort "docker is not reachable"
  local tool
  for tool in node pnpm tar git timeout; do
    command -v "$tool" >/dev/null || abort "$tool is not on PATH"
  done
  git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1 || abort "$ROOT has no HEAD to archive"
  say "HEAD $(git -C "$ROOT" rev-parse --short HEAD), docker $(docker version -f '{{.Server.Version}}'), buildx $(docker buildx version | cut -d' ' -f2), compose $(docker compose version --short), pnpm $(pnpm --version), node $(node --version)"
  [[ ! -d /mnt/c ]] || say "C: free before: $(free_gb) GB"
  docker system df | indent
  check_disk
  remove_artifacts
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/haive-module-smoke.XXXXXX") || abort "mktemp failed"
  TMP=$(cd "$TMP" && pwd -P)
  LOG_DIR=${HAIVE_SMOKE_LOG_DIR:-$TMP/logs}
  mkdir -p "$LOG_DIR" && LOG_DIR=$(cd "$LOG_DIR" && pwd -P) || abort "cannot create the log dir $LOG_DIR"
  REG_DIR=$TMP/registry
  TREE=$TMP/tree
  T1=$(token)
  T2=$(token)
  T3=$(token)
  T4=$(token)
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
