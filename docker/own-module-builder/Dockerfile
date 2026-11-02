# syntax=docker/dockerfile:1.7
# Root build context, shared with the runtime Dockerfiles. A customer build uses a
# vendor-prepared context containing ONLY its entitled packages/dependency lists.
FROM node:26-alpine AS production
RUN apk add --no-cache python3 make g++ libc6-compat git docker-cli docker-cli-buildx \
 && npm install -g corepack@latest && corepack enable \
 && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY packages/database ./packages/database
COPY packages/shared ./packages/shared
COPY packages/web-kit ./packages/web-kit
COPY packages/api ./packages/api
COPY packages/worker ./packages/worker
COPY packages/web ./packages/web
COPY modules ./modules
COPY scripts/gen-modules.mjs scripts/own-module-builder.mjs ./scripts/
# Store and installed packages stay baked in: the customer's rebuild has no vendor token.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile
RUN pnpm --filter @haive/database build \
 && pnpm --filter @haive/shared build \
 && pnpm --filter @haive/web-kit build
ARG HAIVE_VERSION=""
ENV HAIVE_VERSION=$HAIVE_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
ENTRYPOINT ["node", "scripts/own-module-builder.mjs"]
