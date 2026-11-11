import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser API transport', () => {
  it('keeps REST, WebSockets and the editor at the web hostname with a remote API', async () => {
    vi.stubGlobal('window', {
      __HAIVE_RUNTIME__: { apiUrl: 'https://api.example.test' },
      location: {
        protocol: 'https:',
        hostname: 'web.example.test',
        port: '8443',
        origin: 'https://web.example.test:8443',
      },
    });
    const client = await import('./api-client');
    expect(client.API_BASE_URL).toBe('https://web.example.test:8443/api/haive');
    expect(client.apiWebSocketUrl('/terminal/id')).toBe(
      'wss://web.example.test:8443/api/haive/terminal/id',
    );
    expect(client.apiEditorUrl('/ide/id/')).toBe('https://web.example.test:8443/ide/id/');
  });

  it('preserves direct same-host REST, WebSocket and editor URLs on different ports', async () => {
    vi.stubGlobal('window', {
      __HAIVE_RUNTIME__: { apiUrl: 'http://localhost:3001/prefix' },
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        origin: 'http://localhost:3000',
      },
    });
    const client = await import('./api-client');
    expect(client.API_BASE_URL).toBe('http://localhost:3001/prefix');
    expect(client.apiWebSocketUrl('/terminal/id')).toBe('ws://localhost:3001/terminal/id');
    expect(client.apiEditorUrl('/ide/id/')).toBe('http://localhost:3001/prefix/ide/id/');
  });

  it('does not mistake an explicit same-host API path on another port for the web proxy', async () => {
    vi.stubGlobal('window', {
      __HAIVE_RUNTIME__: { apiUrl: 'http://localhost:3001/api/haive' },
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        origin: 'http://localhost:3000',
      },
    });
    const client = await import('./api-client');
    expect(client.apiWebSocketUrl('/terminal/id')).toBe('ws://localhost:3001/terminal/id');
    expect(client.apiEditorUrl('/ide/id/')).toBe('http://localhost:3001/api/haive/ide/id/');
  });
});
