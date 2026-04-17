# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
# Native build deps + git/unzip for repo ops + docker CLI for sandbox orchestration.
RUN apk add --no-cache \
      python3 make g++ libc6-compat \
      git unzip curl ca-certificates \
      docker-cli docker-cli-buildx
# Host-mounted repos have a different UID than the worker process; bypass git's
# safe.directory ownership check so repo ops don't fail with "dubious ownership".
RUN git config --system --add safe.directory '*'
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# clawker (sandbox runtime). Pin a tagged release via build arg; default empty
# leaves the binary uninstalled so Phase 0 scaffold builds without an external
# fetch. Phase 4 sets CLAWKER_RELEASE_URL to a real release asset URL.
ARG CLAWKER_RELEASE_URL=""
RUN if [ -n "$CLAWKER_RELEASE_URL" ]; then \
      curl -fsSL -o /usr/local/bin/clawker "$CLAWKER_RELEASE_URL" && \
      chmod +x /usr/local/bin/clawker && \
      /usr/local/bin/clawker --version; \
    else \
      echo "clawker not installed (CLAWKER_RELEASE_URL build arg not set)"; \
    fi

RUN mkdir -p /var/lib/haive/repos
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
COPY packages/worker ./packages/worker
RUN pnpm --filter @haive/shared build \
 && pnpm --filter @haive/database build \
 && pnpm --filter @haive/worker build

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
COPY --from=builder /app/packages/worker/package.json ./packages/worker/
COPY --from=builder /app/packages/worker/dist ./packages/worker/dist
COPY --from=builder /app/packages/worker/node_modules ./packages/worker/node_modules
CMD ["node", "packages/worker/dist/index.js"]
