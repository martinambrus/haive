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

RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      tini

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /haive/workdir

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash"]
