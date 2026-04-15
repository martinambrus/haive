# haive-cli-sandbox
#
# Short-lived one-shot image used by the worker to probe and execute CLI
# tools in an isolated container. The worker spawns `docker run --rm` against
# this image for each CLI invocation (probe or real exec). Wrappers and
# optional extra files are injected via the haive_wrappers named volume,
# which the worker mounts read-only at /haive/wrappers.
#
# All supported CLIs are baked into the base image at the version available
# when this image is built. Users can pin a specific version per provider in
# the UI; doing so triggers a per-provider image layered on this base that
# reinstalls the targeted CLI at the chosen version. Auto-update mechanisms
# are disabled for every CLI so pins cannot drift at runtime.

FROM node:24-alpine

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      tini \
      unzip

# Claude Code (Anthropic) - binary: claude
RUN npm install -g @anthropic-ai/claude-code && claude --version

# Codex (OpenAI) - binary: codex
RUN npm install -g @openai/codex && codex --version

# Gemini CLI (Google) - binary: gemini
RUN npm install -g @google/gemini-cli && gemini --version

# Amp (Sourcegraph) - binary: amp
RUN npm install -g @sourcegraph/amp && amp --version

# Qwen Code (Alibaba) - binary: qwen
RUN npm install -g @qwen-code/qwen-code && qwen --version

# Kiro CLI (AWS) - binary: kiro-cli. Installer script, no version pinning.
# Kiro installs to /root/.local/bin; add to PATH for all subsequent layers and runtime.
ENV PATH="/root/.local/bin:$PATH"
RUN curl -fsSL https://cli.kiro.dev/install | bash || true

# Grok: no first-party xAI CLI available as of 2026-04. Skipped.
# Z.AI: reuses the `claude` binary via ANTHROPIC_BASE_URL override at run time.

# Disable auto-updaters so pinned versions cannot drift.
ENV DISABLE_AUTOUPDATER=1
ENV AMP_SKIP_UPDATE_CHECK=1

RUN mkdir -p /root/.codex && \
    printf '%s\n' 'check_for_update_on_startup = false' > /root/.codex/config.toml

RUN mkdir -p /etc/gemini-cli && \
    printf '%s\n' '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}' > /etc/gemini-cli/settings.json

RUN mkdir -p /root/.qwen && \
    printf '%s\n' '{"general":{"enableAutoUpdate":false}}' > /root/.qwen/settings.json

RUN mkdir -p /root/.kiro/settings && \
    printf '%s\n' '{"app":{"disableAutoupdates":true}}' > /root/.kiro/settings/cli.json

WORKDIR /haive/workdir

# Default entrypoint is a plain shell so `docker run haive-cli-sandbox <cmd> <args>`
# works without an explicit entrypoint flag. tini reaps any zombies from
# wrapper scripts that fork background processes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash"]
