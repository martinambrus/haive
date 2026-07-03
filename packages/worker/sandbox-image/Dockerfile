# haive-cli-sandbox:latest -- sandbox-core (glibc / debian base)
#
# Minimal fallback base used by the image-composer when a task has no
# env-template (i.e. env-replicate did not run). When an env-template
# IS present, the composer uses the env-template Dockerfile as base
# instead and this image is not referenced.
#
# glibc base (node:24-bookworm-slim) rather than Alpine/musl: npm-based CLIs run
# on node (fine on either libc), but native CLIs can be glibc-only. Antigravity's
# `agy` is a dynamically linked glibc binary with no musl build, so it cannot run
# on Alpine; debian glibc lets both kinds work. amp's `#!/usr/bin/env -S` shebang
# also works here because debian ships GNU coreutils/env by default.
#
# CLI install lines are layered on top at compose time via
# packages/worker/src/sandbox/image-composer.ts using codegen from
# @haive/shared's CLI_INSTALL_METADATA. Auto-updaters are disabled per
# CLI so pinned versions cannot drift at runtime.

FROM node:24-bookworm-slim

# Base tooling. bash + GNU coreutils/env are already present on debian.
# uv has no apt package and is installed via its official installer below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      nano \
      ripgrep \
      tini \
      tmux \
 && rm -rf /var/lib/apt/lists/*

# uv (Astral) — provides `uvx`, used by the git MCP server. Installed to
# /usr/local/bin so it is on PATH for the node user (the installer otherwise
# drops into $HOME/.local/bin).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && uv --version

# rtk (Rust Token Killer) — proxies dev commands to compress tool output before
# it lands in the LLM context. Pinned by tag + sha256; opt-in per-repo via
# `repositories.rtk_enabled`. Upstream ships a static musl x86_64 binary, which
# runs on glibc too; aarch64 has no asset, so we skip cleanly on non-x86_64 (the
# per-CLI hook entries we still write in those repos will be no-ops since the
# binary won't resolve on PATH).
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
# files + sub-dirs like `.claude/backups`. node:24-bookworm-slim already
# provides the node user/group at uid/gid 1000.
RUN mkdir -p /home/node/.claude \
             /home/node/.codex \
             /home/node/.gemini \
             /home/node/.gemini/antigravity-cli \
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
#
# The reject rules for `Task` (spawn a subagent) and `oracle` (reasoning
# subagent) come FIRST so they win by first-match over the `*` allow — this
# stops an onboarding-mining agent spawning its own subagents (which only
# duplicate Haive's own per-capability fan-out and multiply token cost).
# Verified against this pinned amp via `amp permissions test Task -c subagent`:
# Task/oracle -> reject, and a reject is NOT overridden by --dangerously-allow-all.
# Haive never uses amp's native subagents (supportsSubagents=false), so this
# global disable is safe.
RUN printf '%s\n' '{"amp.permissions":[{"tool":"Task","action":"reject"},{"tool":"oracle","action":"reject"},{"tool":"*","action":"allow"}]}' \
      > /etc/haive-amp-settings.json \
 && chmod 0644 /etc/haive-amp-settings.json

# Disable Gemini CLI's autonomous subagents (experimental.enableAgents, default
# true — the main agent otherwise proactively calls invoke_agent to delegate).
# Baked as gemini's SYSTEM settings file, which per gemini-cli docs OVERRIDES all
# user/project settings (highest precedence): the per-user ~/.gemini volume and
# the repo's own .gemini/settings.json cannot re-enable it. Haive never uses
# gemini's native subagents (supportsSubagents=false), so a global disable is safe
# and keeps a mining agent from fanning out and burning tokens. Default Linux path
# /etc/gemini-cli/settings.json (overridable via GEMINI_CLI_SYSTEM_SETTINGS_PATH).
RUN mkdir -p /etc/gemini-cli \
 && printf '%s\n' '{"experimental":{"enableAgents":false}}' > /etc/gemini-cli/settings.json \
 && chmod 0644 /etc/gemini-cli/settings.json

# Entrypoint shim restores ~/.claude.json from the .claude/ named-volume copy
# on every container start. Required because claude-code stores OAuth tokens
# in a single ~/.claude.json file and named volumes mount dirs only.
COPY --chmod=0755 restore-claude.sh /usr/local/bin/restore-claude.sh

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /haive/workdir

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/restore-claude.sh"]
CMD ["bash"]
