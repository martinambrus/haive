import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { displayOllamaUrl, isOllamaUrlRedaction } from '../src/ollama-url.js';

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

it.each(['schemeless', 'mailto', 'localhost', 'ftp'])('M1 fails closed for %s URLs', (kind) => {
  const secret = randomBytes(24).toString('hex');
  const value =
    kind === 'schemeless'
      ? `admin:${secret}@10.0.0.5:11434`
      : kind === 'mailto'
        ? `mailto:user:${secret}@host`
        : kind === 'ftp'
          ? `ftp://user:${secret}@host`
          : 'localhost:11434';
  expect(displayOllamaUrl(value)).toBe('(invalid URL)');
});
it.each(['path', 'query', 'fragment', 'all'])(
  'M2 hides %s and accepts exactly its displayed form',
  (kind) => {
    const secret = randomBytes(24).toString('hex');
    const path = kind === 'path' || kind === 'all' ? `/${secret}` : '';
    const query = kind === 'query' || kind === 'all' ? `?token=${secret}` : '';
    const fragment = kind === 'fragment' || kind === 'all' ? `#${secret}` : '';
    const safe = `https://embed.example:11434${path ? '/***' : ''}${query ? '?***' : ''}${fragment ? '#***' : ''}`;
    expect(displayOllamaUrl(`https://embed.example:11434${path}${query}${fragment}`)).toBe(safe);
    expect(isOllamaUrlRedaction(safe)).toBe(true);
    expect(displayOllamaUrl(safe)).toBe(safe);
  },
);
it.each([
  `http://***:${randomBytes(12).toString('hex')}@host`,
  'http://***@host/private',
  'http://host/***/extra',
  'mailto:***@host',
  'http://host?***=value',
  'http://host/#***',
])('M2 refuses non-display redaction %s', (value) => {
  expect(isOllamaUrlRedaction(value)).toBe(false);
});
