# haive-cli-sandbox (base)
#
# Minimal base image used by the worker as a starting point for per-CLI
# sandbox images. This image itself contains NO CLI binaries -- those are
# installed lazily into layered images keyed by name+version and cached
# locally in the Docker image store, so multiple providers targeting the
# same CLI+version reuse a single image.
#
# The worker builds layered images on-demand via the BullMQ build job,
# using codegen lines from @haive/shared's CLI_INSTALL_METADATA. Each
# layered image disables the CLI's native auto-updater so pinned versions
# cannot drift at runtime.

FROM node:24-alpine

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      tini \
      unzip

# Installer-based CLIs (kiro) drop binaries in /root/.local/bin. Include it
# on PATH so any layered image built from this base picks them up without
# each codegen output having to re-declare it.
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /haive/workdir

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash"]
