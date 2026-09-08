# syntax=docker/dockerfile:1.7
#
# The updater. Runs as a ONE-SHOT container that is NOT part of the compose project it swaps —
# a process cannot `compose up -d` itself out of existence and survive to verify the result or
# roll it back.
#
# Its own image rather than reusing the api's, for one concrete reason: the api image carries
# `docker-cli` (it shells out to stop sandbox containers) but NOT the compose plugin, and an
# upgrade is compose all the way down. Adding compose to api and worker would put it in two images
# that never use it.
FROM node:26-alpine AS base
# docker-cli AND the compose plugin: this image's entire job is to drive `docker compose` against
# the socket the caller mounts. Without the plugin `docker compose` is "unknown command".
RUN apk add --no-cache docker-cli docker-cli-compose
RUN npm install -g corepack@latest && \
    corepack enable && \
    for i in 1 2 3; do \
      corepack prepare pnpm@10.34.5 --activate && break || { [ "$i" = 3 ] && exit 1; sleep 5; }; \
    done
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
# Every package's tsconfig extends this. Without it tsc silently falls back to its defaults and the
# build fails on top-level await, import.meta and Map iteration — all of which the base config
# permits. Same line, same reason, as the api and worker Dockerfiles.
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/updater/package.json ./packages/updater/
RUN pnpm install --frozen-lockfile=false --filter @haive/updater... --filter @haive/shared --filter @haive/database

FROM deps AS builder
COPY packages/shared ./packages/shared
COPY packages/database ./packages/database
COPY packages/updater ./packages/updater
RUN pnpm --filter @haive/database build \
 && pnpm --filter @haive/shared build \
 && pnpm --filter @haive/updater build

FROM base AS production
ENV NODE_ENV=production
# Stamped by the release workflow, so an updater can report which release it is.
ARG HAIVE_VERSION=""
ENV HAIVE_VERSION=$HAIVE_VERSION
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=builder /app/packages/updater/package.json ./packages/updater/
COPY --from=builder /app/packages/updater/dist ./packages/updater/dist
COPY --from=builder /app/packages/updater/node_modules ./packages/updater/node_modules
ENTRYPOINT ["node", "packages/updater/dist/cli.js"]
