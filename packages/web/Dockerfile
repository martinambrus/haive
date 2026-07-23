# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS base
RUN apk add --no-cache python3 make g++ libc6-compat
# Node 26 unbundled corepack, so install it before enabling. corepack then
# downloads pnpm from the npm registry with no retry; a transient ECONNRESET
# fails the whole build (seen in CI), so retry up to 3 times.
RUN npm install -g corepack@latest && \
    corepack enable && \
    for i in 1 2 3; do \
      corepack prepare pnpm@9.15.4 --activate && break || { [ "$i" = 3 ] && exit 1; sleep 5; }; \
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
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY packages/shared ./packages/shared
COPY packages/database ./packages/database
COPY packages/web ./packages/web
# @haive/shared imports @haive/database, so database's dist must exist before
# shared (and web) build; build it first. Without this the builder fails with
# TS2307 "Cannot find module '@haive/database'".
RUN pnpm --filter @haive/database build \
 && pnpm --filter @haive/shared build \
 && pnpm --filter @haive/web build

FROM base AS production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/packages/web/public ./packages/web/public
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
EXPOSE 3000
CMD ["node", "packages/web/server.js"]
