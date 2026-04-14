# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN apk add --no-cache python3 make g++ libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
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
RUN pnpm --filter @haive/shared build \
 && pnpm --filter @haive/database build \
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
