import { describe, expect, it } from 'vitest';
import { integrationProviderSpecSchema, moduleManifestSchema } from '../src/modularity/index.js';
import {
  DEVICE,
  OAUTH,
  OPERATION,
  fixtureManifest,
  fixtureProvider,
  type Raw,
} from './module-integrations-fixtures.js';

const withProvider = (over: Raw): Raw =>
  fixtureManifest('fx', { integrations: [fixtureProvider('fx', over)] });

/** Where the manifest names a key it does not know, and which. */
function unrecognized(manifest: Raw): Array<{ path: string; keys: string[] }> {
  const result = moduleManifestSchema.safeParse(manifest);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? [{ path: issue.path.join('.'), keys: issue.keys }] : [],
  );
}

describe('a module provider spec', () => {
  it('refuses a key the spec does not know, at every level, naming it and where it sits', () => {
    const sloppy: Array<[string, Raw, string, string]> = [
      [
        'a misspelt provider key',
        withProvider({ selfhosted: true }),
        'integrations.0',
        'selfhosted',
      ],
      [
        'authorizeParams on a device method',
        withProvider({ auth: [{ ...DEVICE, authorizeParams: { prompt: 'consent' } }] }),
        'integrations.0.auth.0',
        'authorizeParams',
      ],
      [
        'a key on an oauth2 method',
        withProvider({ auth: [{ ...OAUTH, pcke: true }] }),
        'integrations.0.auth.0',
        'pcke',
      ],
      [
        'a key on userInfo',
        withProvider({ auth: [{ ...OAUTH, userInfo: { ...OAUTH.userInfo, label: '/name' } }] }),
        'integrations.0.auth.0.userInfo',
        'label',
      ],
      [
        'a key on the scopes',
        withProvider({ auth: [{ ...OAUTH, scopes: { ...OAUTH.scopes, admin: ['all'] } }] }),
        'integrations.0.auth.0.scopes',
        'admin',
      ],
      [
        'a key on an operation',
        withProvider({ operations: [{ ...OPERATION, timeoutMs: 5 }] }),
        'integrations.0.operations.0',
        'timeoutMs',
      ],
      [
        'a key on a category',
        fixtureManifest('fx', {
          categories: [{ id: 'module.fx.docs', label: 'Docs', descripton: 'typo' }],
        }),
        'categories.0',
        'descripton',
      ],
    ];

    for (const [name, manifest, path, key] of sloppy) {
      expect(unrecognized(manifest), name).toEqual([{ path, keys: [key] }]);
    }
  });

  it('keeps accepting what the spec does know: authorizeParams on an oauth2 method, an entitlement', () => {
    const manifest = withProvider({
      auth: [{ ...OAUTH, authorizeParams: { access_type: 'offline' } }],
      entitlementId: 'fx',
    });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  describe('apiHosts', () => {
    const parse = (apiHosts: unknown) =>
      integrationProviderSpecSchema.safeParse(fixtureProvider('fx', { apiHosts }));

    it.each([
      'api.example.com',
      'example.com',
      'a-b.example.co.uk',
      'xn--bcher-kva.example',
      `${'a'.repeat(63)}.example.com`,
      'v1.api.eu-west-1.example.com',
    ])('accepts %s', (host) => {
      expect(parse([host]).success).toBe(true);
    });

    it.each([
      ['a single label', 'localhost'],
      ['an upper case letter', 'API.example.com'],
      ['a scheme', 'https://api.example.com'],
      ['a port', 'api.example.com:8443'],
      ['a path', 'api.example.com/v1'],
      ['a user', 'user@api.example.com'],
      ['a wildcard', '*.example.com'],
      ['an IPv4 literal', '10.0.0.1'],
      ['an IPv6 literal', '[::1]'],
      ['a leading hyphen', '-a.example.com'],
      ['a trailing hyphen', 'a-.example.com'],
      ['an empty label', 'a..example.com'],
      ['a trailing dot', 'api.example.com.'],
      ['an underscore', 'a_b.example.com'],
      ['a label of 64 characters', `${'a'.repeat(64)}.example.com`],
      ['a name over 253 characters', `${'a'.repeat(60)}.`.repeat(4) + 'example.com'],
      ['surrounding space', ' api.example.com'],
      ['nothing', ''],
    ])('refuses %s', (_name, host) => {
      expect(parse([host]).success).toBe(false);
    });

    it('refuses an empty list and accepts a list of several hosts', () => {
      expect(parse([]).success).toBe(false);
      expect(parse(['api.example.com', 'files.example.com']).success).toBe(true);
    });
  });
});
