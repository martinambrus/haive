# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS base
# docker-cli: api shells out to `docker rm -f` to interrupt sandbox CLI
# containers when the user clicks Stop & Retry on a running step. The
# socket mount is supplied by docker-compose; the binary must live in the
# image. Install once in the base layer so dev (`target: deps`) and prod
# (`production`) both have it.
#
# git: the plan-snapshot status endpoint reads whether the committed
# `.haive-data/plan.{json,md}` are tracked, dirty and pushed, which is four
# read-only `git` invocations against the haive_repos mount this image already
# has. Without the binary every probe failed identically to "this is not a Git
# checkout", so the plan header read "Not committed" on a repository whose
# snapshot was committed and pushed — a wrong answer that looked like a real
# one. Read-only status only; anything that WRITES history (commit, push, the
# fast-forward pull) still runs in the worker, which is why this is not a
# widening of the api/worker boundary.
RUN apk add --no-cache python3 make g++ libc6-compat docker-cli git
# The repos in the shared volume are owned by uid 1000 and this image runs as
# root, so git 2.35.2+ refuses every command with "detected dubious ownership".
# The worker's Dockerfile carries the identical line for the identical reason;
# without it, installing the binary above changes nothing — MEASURED, the probe
# still reported "not a Git checkout" with git 2.54.0 present.
RUN git config --system --add safe.directory '*'
# Node 26 unbundled corepack, so install it before enabling. corepack then
# downloads pnpm from the npm registry with no retry; a transient ECONNRESET
# fails the whole build (seen in CI), so retry up to 3 times.
RUN npm install -g corepack@latest && \
    corepack enable && \
    for i in 1 2 3; do \
      corepack prepare pnpm@10.34.5 --activate && break || { [ "$i" = 3 ] && exit 1; sleep 5; }; \
    done
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/api/package.json ./packages/api/
COPY packages/worker/package.json ./packages/worker/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile=false

FROM deps AS builder
COPY packages/shared ./packages/shared
COPY packages/database ./packages/database
COPY packages/api ./packages/api
# @haive/shared imports @haive/database, so database's dist must exist before
# shared (and api) build; build it first (deps before dependents). See the
# matching .dockerignore **/node_modules fix and packages/web/Dockerfile.
RUN pnpm --filter @haive/database build \
 && pnpm --filter @haive/shared build \
 && pnpm --filter @haive/api build

FROM base AS production
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=builder /app/packages/api/package.json ./packages/api/
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/node_modules ./packages/api/node_modules
EXPOSE 3001
CMD ["node", "packages/api/dist/index.js"]
