# haive-cli-sandbox
#
# Short-lived one-shot image used by the worker to probe and execute CLI
# tools in an isolated container. The worker spawns `docker run --rm` against
# this image for each CLI invocation (probe or real exec). Wrappers and
# optional extra files are injected via the haive_wrappers named volume,
# which the worker mounts read-only at /haive/wrappers.
#
# Extending: install additional CLI binaries below as global npm packages or
# curl downloads. Rebuild via `docker compose --profile sandbox build cli-sandbox`
# whenever this file changes. Per-provider config changes do NOT require a
# rebuild -- user wrapper content is materialized per-run via the bind mount.

FROM node:24-alpine

RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      tini

# Claude Code CLI (Anthropic). Installs the `claude` binary on PATH.
RUN npm install -g @anthropic-ai/claude-code && claude --version

# TODO: add further CLIs once validated:
#   codex:   npm install -g @openai/codex-cli
#   gemini:  npm install -g @google/gemini-cli
#   amp:     curl -fsSL https://ampcode.com/install.sh | sh
#   grok:    (no public CLI yet)
#   qwen:    (research needed)
#   kiro:    (research needed)
#   zai:     reuses the claude binary with ANTHROPIC_BASE_URL override

WORKDIR /haive/workdir

# Default entrypoint is a plain shell so `docker run haive-cli-sandbox <cmd> <args>`
# works without an explicit entrypoint flag. tini reaps any zombies from
# wrapper scripts that fork background processes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash"]
