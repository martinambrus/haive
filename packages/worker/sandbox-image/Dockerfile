# haive-cli-sandbox:latest -- sandbox-core
#
# Minimal fallback base used by the image-composer when a task has no
# env-template (i.e. env-replicate did not run). When an env-template
# IS present, the composer uses the env-template Dockerfile as base
# instead and this image is not referenced.
#
# Contents are the bare minimum required for any CLI install layer to
# succeed: node+npm for npm-kind CLIs, curl+bash kept for future curl-script
# installs, git for repo operations, tini for signal handling. The PATH
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
      nano \
      ripgrep \
      tini \
      tmux \
      uv

# rtk (Rust Token Killer) — proxies dev commands to compress tool output before
# it lands in the LLM context. Pinned by tag + sha256; opt-in per-repo via
# `repositories.rtk_enabled`. Upstream only ships musl for x86_64; aarch64
# alpine has no musl asset, so we skip cleanly on non-x86_64 (the per-CLI hook
# entries we still write in those repos will be no-ops since the binary won't
# resolve on PATH).
ARG RTK_RELEASE_VERSION=v0.37.2
ARG RTK_X86_64_MUSL_SHA256=3dfb7a05636a68687ba1c5aa696fa8d5fcb494447ded86d9eb8b88b7100a37c6
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) \
        url="https://github.com/rtk-ai/rtk/releases/download/${RTK_RELEASE_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz"; \
        sha="${RTK_X86_64_MUSL_SHA256}"; \
        tmp="/tmp/rtk.tgz"; \
        curl -fsSL "$url" -o "$tmp"; \
        echo "${sha}  ${tmp}" | sha256sum -c -; \
        tar -xzf "$tmp" -C /tmp; \
        install -m 0755 "$(find /tmp -maxdepth 3 -type f -name rtk -perm -u+x | head -n1)" /usr/local/bin/rtk; \
        rm -rf "$tmp" /tmp/rtk-*; \
        /usr/local/bin/rtk --version; \
        ;; \
      *) \
        echo "rtk: skipping install on unsupported arch '$arch' (no musl asset upstream)"; \
        ;; \
    esac

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

# amp stream-json mode rejects tools that require approval with an
# "error_during_execution" on the first librarian/* invocation. Wire a
# blanket allow rule through a baked-in settings file we point amp at via
# `--settings-file`. Keeping it outside the mounted ~/.config/amp volume
# means user-level settings.json (if they ever write one) can't clobber it.
RUN printf '%s\n' '{"amp.permissions":[{"tool":"*","action":"allow"}]}' \
      > /etc/haive-amp-settings.json \
 && chmod 0644 /etc/haive-amp-settings.json

# Entrypoint shim restores ~/.claude.json from the .claude/ named-volume copy
# on every container start. Required because claude-code stores OAuth tokens
# in a single ~/.claude.json file and named volumes mount dirs only.
COPY --chmod=0755 restore-claude.sh /usr/local/bin/restore-claude.sh

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /haive/workdir

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/restore-claude.sh"]
CMD ["bash"]
