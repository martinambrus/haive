# Sandbox-facing inference/read-only gate. No npm dependencies.
FROM node:26-bookworm-slim
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 11434
CMD ["node", "server.mjs"]
