# haive-ddev-runner: a per-task nested-Docker (DinD) environment that runs DDEV.
#
# Launched privileged, one per task that needs a DDEV environment. The repo is
# mounted via the haive_repos named volume, so DDEV — talking to THIS container's
# OWN nested dockerd — bind-mounts the project from a real local path (the host
# daemon can't bind-mount the named-volume repo; the nested daemon can).
#
# DDEV's installer + runtime refuse to run as root, so we run dockerd as root via
# the entrypoint but drive `ddev` as the non-root `ddev` user (uid 1000, matching
# the repo volume's chowned ownership) via `docker exec -u ddev`.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sudo iptables uidmap libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

# Docker CE (engine + compose plugin) from Docker's official repo — DDEV expects
# a recent docker + the compose v2 plugin.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# DDEV + mkcert from DDEV's apt repo.
#
# DDEV_VERSION is PINNED on purpose. Unpinned, every image rebuild silently adopted whatever
# the apt repo served that day, so the CLI drifted underneath projects whose .ddev/config.yaml
# carries a `ddev_version_constraint` — a repo that booted last week started failing with
# "your DDEV version 'X' doesn't meet the constraint" for no change of its own. It also let the
# CLI diverge from the ddev/* images already cached on the host. Bump this deliberately (and
# rebuild with `pnpm docker rebuild`); `apt-cache policy ddev` inside the image lists what the
# repo currently offers.
ARG DDEV_VERSION=1.25.3
RUN curl -fsSL https://apt.fury.io/drud/gpg.key | gpg --dearmor -o /etc/apt/keyrings/ddev.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/ddev.gpg] https://apt.fury.io/drud/ * *" > /etc/apt/sources.list.d/ddev.list \
    && apt-get update && apt-get install -y --no-install-recommends "ddev=${DDEV_VERSION}" mkcert \
    && rm -rf /var/lib/apt/lists/*

# Browser testing inside the runner (08a-browser-verify): node + chromium +
# puppeteer-core, with the check scripts baked in. puppeteer-core is installed
# under /opt so `node /opt/browser-check.js` resolves it from there. The X stack
# (xvfb + x11vnc + socat + fonts) powers the interactive mode: a headed Chromium
# on a virtual display the user watches/drives through the web noVNC panel,
# while agents drive the same browser over CDP (socat exposes the
# localhost-only headed CDP port to the internal sandbox network).
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm chromium xvfb x11vnc socat fonts-dejavu procps \
    && rm -rf /var/lib/apt/lists/*
COPY browser-check.js /opt/browser-check.js
COPY browser-probe-connect.js /opt/browser-probe-connect.js
# puppeteer-core is pinned EXACT, not to a major. A bare `@22` re-resolved on
# every image build, so the browser-verify step could change behaviour with no
# commit of ours -- and there is no lockfile here for Dependabot to watch. The
# ceiling is set by node, not by us: this image takes nodejs from bookworm apt,
# which is 18.20.4, and puppeteer-core >= 25 requires node >= 22.12.0. Bump the
# node source first if you want to cross that line; 24.x is the last line that
# runs on 18. Verify a bump with a real browser-verify task -- CI never builds
# this image, so nothing else exercises the CDP path.
ARG PUPPETEER_CORE_VERSION=24.43.1
RUN cd /opt && npm init -y >/dev/null 2>&1 \
    && npm install "puppeteer-core@${PUPPETEER_CORE_VERSION}" >/dev/null 2>&1
ENV CHROME_PATH=/usr/bin/chromium
COPY start-browser-desktop.sh /usr/local/bin/start-browser-desktop.sh
RUN chmod +x /usr/local/bin/start-browser-desktop.sh

RUN useradd -m -u 1000 -s /bin/bash -G docker,sudo ddev \
    && echo 'ddev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ddev \
    && chmod 0440 /etc/sudoers.d/ddev

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Back the nested dockerd's storage with a real volume, NOT the container's own
# overlay rootfs — otherwise overlay-on-overlay fails ("failed to convert
# whiteout file ... operation not permitted"). This is why docker:dind does the
# same. The worker should `docker rm -f -v` to drop the anonymous volume.
VOLUME /var/lib/docker

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
