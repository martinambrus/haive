import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { displayOllamaUrl, isOllamaUrlRedaction } from '../src/lib/global-kb-ollama-url.js';

it.each(['password', 'username', 'encoded', 'malformed'])('never displays %s userinfo', (kind) => {
  const secret = randomBytes(24).toString('hex');
  const value =
    kind === 'malformed'
      ? `http://user:${secret}@[broken`
      : kind === 'username'
        ? `http://${secret}@embed.example`
        : `http://user:${kind === 'encoded' ? encodeURIComponent(secret + ':@') : secret}@embed.example`;
  const safe = displayOllamaUrl(value);
  expect(safe.includes(secret)).toBe(false);
  expect(isOllamaUrlRedaction(safe)).toBe(true);
});

it('preserves ordinary endpoints byte for byte and keeps missing values empty', () => {
  expect(displayOllamaUrl('http://embed.example:11434')).toBe('http://embed.example:11434');
  expect(displayOllamaUrl(null)).toBe('');
  expect(isOllamaUrlRedaction('http://embed.example:11434')).toBe(false);
});
