# Tiny stateless proxy that hoists a trailing role:"system" message into the
# top-level `system` field of OpenRouter /v1/messages requests, so models whose
# backends require system-first accept what the claude binary sends.
# No npm dependencies — Node built-in http/https only.
FROM node:26-bookworm-slim
WORKDIR /app
COPY server.mjs hoist.mjs ./
USER node
EXPOSE 8789
CMD ["node", "server.mjs"]
