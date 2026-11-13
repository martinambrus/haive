import { expect, it } from 'vitest';
import {
  isOllamaModelAllowed,
  normalizeOllamaModel,
  isInStackOllamaBaseUrl,
  parseModelfile,
} from '../src/cli-providers/index.js';
import { DEFAULT_EMBED_MODEL } from '../src/global-kb/connection.js';

const references: [string, boolean][] = [
  ['embed', true],
  ['EMBED:latest', true],
  ['library/embed', true],
  ['namespace/embed:latest', true],
  ['registry.ollama.ai/library/embed', true],
  ['registry.ollama.ai/namespace/embed:latest', true],
  ['registry.ollama.ai:443/library/embed', false],
  ['REGISTRY.OLLAMA.AI/library/embed', false],
  ['registry.ollama.ai./library/embed', false],
  ['foreign.example/library/embed', false],
  ['foreign.example:5000/namespace/embed:tag', false],
  ['127.0.0.1/library/embed', false],
  ['127.0.0.1:11434/library/embed', false],
  ['[::1]:11434/library/embed', false],
  ['localhost/library/embed', false],
  ['LOCALHOST/library/embed', false],
  ['internal/library/embed', false],
  ['foreign.example/embed', false],
  ['foreign.example:5000/embed', false],
  ['registry.ollama.ai/embed', false],
  ['localhost/embed', false],
  ['LOCALHOST/embed', false],
  ['embed/', false],
  ['/embed', false],
  ['library//embed', false],
  ['registry.ollama.ai//embed', false],
  ['registry.ollama.ai/library/embed/', false],
  ['registry.ollama.ai/library/', false],
  ['https://registry.ollama.ai/library/embed', false],
  ['', false],
];

it.each(references)('restricts embedding-configured reference %j by role', (model, allowed) => {
  const policy = { embedModel: model, allowlist: null };
  for (const role of ['user', undefined]) {
    expect(isOllamaModelAllowed(role, model, policy), String(role)).toBe(allowed);
  }
  expect(isOllamaModelAllowed('admin', model, policy)).toBe(true);
});

it.each([
  'foreign.example/library/embed:tag',
  'foreign.example:5000/namespace/embed',
  'localhost/library/embed',
  '127.0.0.1:11434/library/embed',
  'registry.ollama.ai:443/library/embed',
  'REGISTRY.OLLAMA.AI/library/embed',
])('keeps an explicitly admin-allowlisted registry reference pullable: %s', (model) => {
  expect(isOllamaModelAllowed('user', model, { embedModel: null, allowlist: model })).toBe(true);
});

it('requires explicit registry approval rather than borrowing a default-registry allowlist entry', () => {
  const policy = { embedModel: 'embed', allowlist: 'library/embed' };
  for (const model of [
    'REGISTRY.OLLAMA.AI/library/embed',
    'registry.ollama.ai:443/library/embed',
  ]) {
    expect(isOllamaModelAllowed('user', model, policy)).toBe(false);
  }
  expect(
    isOllamaModelAllowed('user', 'FOREIGN.EXAMPLE/library/embed', {
      embedModel: null,
      allowlist: 'foreign.example/library/embed',
    }),
  ).toBe(false);
});

it('preserves Ollama’s right-to-left name normalization separately from registry permission', () => {
  expect(normalizeOllamaModel('localhost/embed')).toBe('registry.ollama.ai/localhost/embed:latest');
  expect(normalizeOllamaModel('foreign.example/embed')).toBeNull();
  expect(normalizeOllamaModel('foreign.example/library/embed')).toBe(
    'foreign.example/library/embed:latest',
  );
});

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
