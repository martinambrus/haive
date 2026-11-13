import { expect, it } from 'vitest';
import {
  normalizeOllamaModel,
  ollamaModelAllowlistSchema,
  OLLAMA_ALLOWLIST_LIMITS,
} from '../src/lib/ollama-pull-policy.js';

it('uses Ollama’s case-insensitive host/namespace/model/tag defaults without conflating tags or registries', () => {
  const canonical = 'registry.ollama.ai/library/qwen3:latest';
  for (const name of [
    'Qwen3',
    'qwen3:LATEST',
    'library/qwen3',
    'REGISTRY.OLLAMA.AI/Library/Qwen3:Latest',
  ]) {
    expect(normalizeOllamaModel(name)).toBe(canonical);
  }
  expect(normalizeOllamaModel('qwen3:8b')).not.toBe(canonical);
  expect(normalizeOllamaModel('other.example/library/qwen3')).not.toBe(canonical);
  expect(normalizeOllamaModel('other.example:5000/ns/qwen3:8b')).toBe(
    'other.example:5000/ns/qwen3:8b',
  );
});

it.each([
  '',
  '*',
  'qwen 3',
  'qwen3:',
  ':latest',
  '../qwen3',
  '/qwen3',
  'a/b/c/d',
  'https://registry.example/ns/model',
  'model@sha256:abcd',
  'bad.namespace/model',
])('refuses a non-model name %j', (name) => {
  expect(normalizeOllamaModel(name)).toBeNull();
});

it('bounds the list at small injected character and entry limits', () => {
  expect(OLLAMA_ALLOWLIST_LIMITS).toEqual({ maxChars: 16_384, maxEntries: 256 });
  const schema = ollamaModelAllowlistSchema({ maxChars: 8, maxEntries: 2 });
  expect(schema.safeParse({ allowlist: '' }).success).toBe(true);
  expect(schema.safeParse({ allowlist: 'a, b\n' }).success).toBe(true);
  expect(schema.safeParse({ allowlist: 'a,b,c' }).success).toBe(false);
  expect(schema.safeParse({ allowlist: 'longmodel' }).success).toBe(false);
  expect(schema.safeParse({ allowlist: '*' }).success).toBe(false);
});
