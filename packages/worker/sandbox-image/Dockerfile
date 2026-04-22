# haive-cli-sandbox:latest -- sandbox-core
#
# Minimal fallback base used by the image-composer when a task has no
# env-template (i.e. env-replicate did not run). When an env-template
# IS present, the composer uses the env-template Dockerfile as base
# instead and this image is not referenced.
#
# Contents are the bare minimum required for any CLI install layer to
# succeed: node+npm for npm-kind CLIs, curl+bash for curl-script CLIs
# (kiro), git for repo operations, tini for signal handling. The PATH
# override picks up installer-based CLIs that drop into /root/.local/bin.
#
# CLI install lines are layered on top at compose time via
# packages/worker/src/sandbox/image-composer.ts using codegen from
# @haive/shared's CLI_INSTALL_METADATA. Auto-updaters are disabled per
# CLI so pinned versions cannot drift at runtime.

FROM node:24-alpine

# coreutils replaces BusyBox `env` with GNU `env`. Required by CLIs whose
# binaries ship shebangs like `#!/usr/bin/env -S node ...` (e.g. amp); the
# `-S` flag is GNU-only and BusyBox env fails with "unrecognized option: S".
RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      tini

# Pre-create CLI auth mount targets owned by the node user. Docker creates
# missing volume mountpoints as root regardless of `User:` — if the image
# already has the path with correct ownership, a named volume mounted there
# inherits node:node and the CLI (running as uid 1000) can write its auth
# files + sub-dirs like `.claude/backups`.
RUN mkdir -p /home/node/.claude \
             /home/node/.codex \
             /home/node/.gemini \
             /home/node/.config/claude \
             /home/node/.config/codex \
             /home/node/.config/gemini \
             /home/node/.config/amp \
             /home/node/.local/share/amp \
 && echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > /home/node/.claude.json \
 && chown -R node:node /home/node

# Entrypoint shim restores ~/.claude.json from the .claude/ named-volume copy
# on every container start. Required because claude-code stores OAuth tokens
# in a single ~/.claude.json file and named volumes mount dirs only.
COPY --chmod=0755 restore-claude.sh /usr/local/bin/restore-claude.sh

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /haive/workdir

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/restore-claude.sh"]
CMD ["bash"]
