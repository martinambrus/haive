import { expect, it } from 'vitest';
import {
  isOllamaModelAllowed,
  isInStackOllamaBaseUrl,
  parseModelfile,
} from '../src/cli-providers/index.js';
import { DEFAULT_EMBED_MODEL } from '../src/global-kb/connection.js';

it('uses operator-controlled models only, with the same normalized names for save and pull', () => {
  const policy = { embedModel: 'embed', allowlist: 'allowed:8b' };
  for (const model of [
    'embed:latest',
    DEFAULT_EMBED_MODEL,
    'registry.ollama.ai/library/ALLOWED:8b',
  ]) {
    expect(isOllamaModelAllowed('user', model, policy)).toBe(true);
  }
  for (const model of ['blocked', 'allowed:70b', 'embed:8b', 'model@sha256:abc']) {
    expect(isOllamaModelAllowed('user', model, policy)).toBe(false);
  }
  expect(isOllamaModelAllowed('admin', 'arbitrary', policy)).toBe(true);
  expect(isOllamaModelAllowed(undefined, 'arbitrary', policy)).toBe(false);
  expect(
    isOllamaModelAllowed('user', 'allowed', { embedModel: null, allowlist: 'allowed,*' }),
  ).toBe(false);
});

it('keeps the worker’s hostname-based in-stack distinction', () => {
  for (const url of [undefined, 'http://ollama:11434', 'http://haive-ollama:11434']) {
    expect(isInStackOllamaBaseUrl(url)).toBe(true);
  }
  for (const url of ['http://external.example:11434', 'http://localhost:11434', 'bad-url']) {
    expect(isInStackOllamaBaseUrl(url)).toBe(false);
  }
});

it('authorizes the effective parsed FROM, ignoring directive text inside multiline bodies', () => {
  expect(parseModelfile('FROM allowed\nSYSTEM """text\nFROM blocked\n"""').from).toBe('allowed');
  expect(parseModelfile('FROM blocked\nFROM allowed').from).toBe('allowed');
});
