import { describe, expect, it } from 'vitest';
import { resolveApiOrigin, FALLBACK_API_URL, type ApiOriginInputs } from './api-origin';

function inputs(over: Partial<ApiOriginInputs> = {}): ApiOriginInputs {
  return {
    config: undefined,
    location: { protocol: 'http:', hostname: 'localhost' },
    buildTime: undefined,
    ...over,
  };
}

describe('the case this exists for', () => {
  // MEASURED on v0.2.0-rc.1: the installer moved the api to 3003 because 3001 was taken, and the
  // browser went on calling 3001 because the port was baked into the bundle at build time.
  it('follows the port the install actually published', () => {
    expect(resolveApiOrigin(inputs({ config: { apiPort: '3003' } }))).toBe('http://localhost:3003');
  });

  // The build-time value must not win once a runtime one exists, or the bug is unchanged.
  it('outranks the build-time value', () => {
    const d = resolveApiOrigin(
      inputs({ config: { apiPort: '3003' }, buildTime: 'http://localhost:3001' }),
    );
    expect(d).toBe('http://localhost:3003');
  });
});

describe('deriving from the browser', () => {
  // `localhost` was always wrong for a browser on another machine. Deriving the host from the
  // page's own location is what makes a remote browser work at all.
  it('uses the host the page was opened on, not a configured one', () => {
    const d = resolveApiOrigin(
      inputs({
        config: { apiPort: '3003' },
        location: { protocol: 'http:', hostname: '10.0.0.7' },
      }),
    );
    expect(d).toBe('http://10.0.0.7:3003');
  });

  it('keeps the page protocol, so an https page does not call http', () => {
    const d = resolveApiOrigin(
      inputs({
        config: { apiPort: '8443' },
        location: { protocol: 'https:', hostname: 'haive.example.com' },
      }),
    );
    expect(d).toBe('https://haive.example.com:8443');
  });
});

describe('an explicit URL', () => {
  it('wins outright, because a reverse proxy is not derivable', () => {
    const d = resolveApiOrigin(
      inputs({
        config: { apiUrl: 'https://api.example.com', apiPort: '3003' },
        location: { protocol: 'http:', hostname: 'localhost' },
      }),
    );
    expect(d).toBe('https://api.example.com');
  });

  // `new URL(path, base)` treats a trailing slash as significant, and an operator is as likely to
  // write one as not.
  it('is normalised so a trailing slash cannot change what a path resolves to', () => {
    expect(resolveApiOrigin(inputs({ config: { apiUrl: 'https://api.example.com/' } }))).toBe(
      'https://api.example.com',
    );
  });
});

describe('falling back', () => {
  // An install that sets none of this must behave exactly as it did before this existed.
  it('uses the build-time value when there is no runtime config', () => {
    expect(resolveApiOrigin(inputs({ buildTime: 'http://localhost:3001' }))).toBe(
      'http://localhost:3001',
    );
  });

  it('and the historical default when there is nothing at all', () => {
    expect(resolveApiOrigin(inputs())).toBe(FALLBACK_API_URL);
  });

  // Server-side there is no `location`, so a port alone cannot be turned into an origin.
  it('does not invent an origin from a port with no location', () => {
    expect(
      resolveApiOrigin(
        inputs({ config: { apiPort: '3003' }, location: undefined, buildTime: 'http://api:3001' }),
      ),
    ).toBe('http://api:3001');
  });
});
