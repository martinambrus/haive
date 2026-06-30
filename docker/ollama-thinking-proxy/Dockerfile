# Tiny stateless proxy that injects thinking:{type:"disabled"} into Ollama Cloud
# /v1/messages requests. No npm dependencies — Node built-in http/https only.
FROM node:26-bookworm-slim
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
