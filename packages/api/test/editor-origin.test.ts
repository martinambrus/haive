import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorOrigin } from '../src/lib/request-origin.js';

afterEach(() => vi.unstubAllEnvs());

describe('configured editor origin', () => {
  it.each([
    ['HTTPS://IDE.EXAMPLE.COM:443', 'https://ide.example.com'],
    ['http://localhost:3001', 'http://localhost:3001'],
    [' https://ide.example.com/ ', 'https://ide.example.com'],
  ])('canonicalises %s', (value, expected) => {
    vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('HAIVE_API_PORT', '3001');
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', value);
    expect(editorOrigin()).toBe(expected);
  });
  it.each([
    'bogus',
    'ftp://ide.example.com',
    'https://u:p@ide.example.com',
    'https://ide.example.com/path',
    'https://ide.example.com/?x',
    'https://ide.example.com/#x',
    'https://ide.example.com/?',
    'https://ide.example.com/#',
    'https://ide.example.com/./',
    'https://ide.example.com\\',
  ])('refuses %s with an operator-facing error', (value) => {
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', value);
    expect(() => editorOrigin()).toThrow('HAIVE_EDITOR_ORIGIN');
  });
  it.each([
    ['https://haive.example.com', 'https://haive.example.com', 'https://haive.example.com:3001'],
    ['https://haive.example.com', 'https://haive.example.com', 'http://haive.example.com'],
    ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'],
  ])('refuses an editor on the app hostname (web %s, api %s, editor %s)', (web, api, value) => {
    vi.stubEnv('WEB_ORIGIN', web);
    vi.stubEnv('HAIVE_PUBLIC_API_URL', api);
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', value);
    expect(() => editorOrigin()).toThrow("hostname other than the app's");
  });
  it('allows an explicit editor origin equal to the default', () => {
    vi.stubEnv('WEB_ORIGIN', 'https://haive.example.com');
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://haive.example.com');
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', 'https://haive.example.com');
    expect(editorOrigin()).toBe('https://haive.example.com');
  });
  it.each(['', '   '])('keeps the API default when unset (%j)', (value) => {
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', value);
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.com/base');
    expect(editorOrigin()).toBe('https://api.example.com');
  });
});

it('refuses an invalid editor origin at boot before opening connections', async () => {
  vi.stubEnv('HAIVE_EDITOR_ORIGIN', 'https://ide.example.com/path');
  const { bootstrap } = await import('../src/bootstrap.js');
  await expect(bootstrap()).rejects.toThrow('HAIVE_EDITOR_ORIGIN');
});
