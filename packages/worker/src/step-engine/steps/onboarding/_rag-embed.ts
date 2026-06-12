// Embedding helpers moved to @haive/shared/rag so the API query path can reuse
// them without importing the worker. Re-exported here so existing worker
// imports keep resolving unchanged.
export {
  OLLAMA_TIMEOUT_MS,
  EMBED_BATCH_SIZE,
  probeOllama,
  ollamaEmbed,
  warmOllamaModel,
  hashEmbed,
  vectorLiteral,
  embedQuery,
} from '@haive/shared/rag';
