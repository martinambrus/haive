import { describe, expect, it } from 'vitest';
import {
  authMethodSpecSchema,
  integrationCategorySpecSchema,
  integrationOperationSchema,
  integrationProviderSpecSchema,
} from '../src/modularity/index.js';

const oauth = {
  kind: 'oauth2',
  authorizeUrl: 'https://example.com/oauth/authorize',
  tokenUrl: 'https://example.com/oauth/token',
  revokeUrl: 'https://example.com/oauth/revoke',
  scopes: { read: ['repo:read'], write: ['repo:write'] },
  pkce: true,
  clientRegistration: ['preregistered', 'dcr'],
};

const device = {
  kind: 'device',
  deviceCodeUrl: 'https://example.com/device/code',
  tokenUrl: 'https://example.com/oauth/token',
  scopes: { read: ['read'], write: ['write'] },
};

const tokenAuth = {
  kind: 'token',
  form: { title: 'Personal access token', fields: [{ id: 'token', type: 'text', label: 'Token' }] },
  help: 'Create a token in the account settings.',
};

const op = {
  opId: 'issues_list',
  description: 'List issues',
  inputSchema: { type: 'object', properties: {} },
  access: 'read',
};

const forge = {
  id: 'github',
  displayName: 'GitHub',
  categories: ['forge', 'issues'],
  selfHosted: false,
  auth: [oauth, tokenAuth],
  mcp: { kind: 'remote', url: 'https://mcp.example.com/sse' },
  operations: [op, { ...op, opId: 'issues_create', access: 'write' }],
};

const moduleProvider = {
  id: 'module.drive-x.google-docs',
  displayName: 'Google Docs',
  categories: ['rich-documents', 'module.google.drive-x'],
  selfHosted: false,
  auth: [device],
  mcp: { kind: 'stdio', package: '@example/docs-mcp', version: '1.2.3' },
  entitlementId: 'drive-x',
};

describe('integrationProviderSpecSchema', () => {
  it('accepts a core forge-like provider', () => {
    expect(integrationProviderSpecSchema.safeParse(forge).success).toBe(true);
  });

  it('accepts a module provider filling a core and a module category', () => {
    expect(integrationProviderSpecSchema.safeParse(moduleProvider).success).toBe(true);
  });

  it('accepts a REST-only provider and a stdio image provider', () => {
    const rest = { ...forge, mcp: undefined };
    const image = {
      ...moduleProvider,
      operations: undefined,
      mcp: { kind: 'stdio', image: 'ghcr.io/example/mcp', version: '1.0.0' },
    };
    expect(integrationProviderSpecSchema.safeParse(rest).success).toBe(true);
    expect(integrationProviderSpecSchema.safeParse(image).success).toBe(true);
  });

  it('accepts operation ids up to 40 characters', () => {
    const operations = ['get_page', 'x'.repeat(40)].map((opId) => ({ ...op, opId }));

    expect(integrationProviderSpecSchema.safeParse({ ...forge, operations }).success).toBe(true);
  });

  it.each([
    ['no surface', { ...forge, mcp: undefined, operations: undefined }],
    ['an empty operations list and no mcp', { ...forge, mcp: undefined, operations: [] }],
    [
      'both image and package',
      { ...moduleProvider, mcp: { kind: 'stdio', image: 'a/b', package: 'c', version: '1' } },
    ],
    ['neither image nor package', { ...moduleProvider, mcp: { kind: 'stdio', version: '1' } }],
    [
      'a stdio server without a version',
      { ...moduleProvider, mcp: { kind: 'stdio', package: 'c' } },
    ],
    ['an http mcp url', { ...forge, mcp: { kind: 'remote', url: 'http://mcp.example.com' } }],
    ['a duplicate opId', { ...forge, operations: [op, { ...op, description: 'again' }] }],
    ['an opId that starts with a digit', { ...forge, operations: [{ ...op, opId: '2fa_enable' }] }],
    ['an opId of 41 characters', { ...forge, operations: [{ ...op, opId: 'x'.repeat(41) }] }],
    [
      'opIds that differ by a separator only',
      {
        ...forge,
        operations: [
          { ...op, opId: 'get.page' },
          { ...op, opId: 'get-page' },
        ],
      },
    ],
    ['empty categories', { ...forge, categories: [] }],
    ['duplicate categories', { ...forge, categories: ['forge', 'forge'] }],
    ['a bad category id', { ...forge, categories: ['Not A Category'] }],
    ['a bad provider id', { ...forge, id: 'Bad Id' }],
    ['no auth method', { ...forge, auth: [] }],
    [
      'a repeated auth kind',
      { ...forge, auth: [oauth, { ...oauth, tokenUrl: 'https://other.example.com/token' }] },
    ],
    [
      'a token auth with a bad form',
      { ...forge, auth: [{ ...tokenAuth, form: { fields: 'nope' } }] },
    ],
  ])('rejects %s', (_name, spec) => {
    expect(integrationProviderSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe('authMethodSpecSchema', () => {
  it('accepts oauth2, device and token methods', () => {
    for (const a of [oauth, device, tokenAuth]) {
      expect(authMethodSpecSchema.safeParse(a).success).toBe(true);
    }
  });

  it('accepts userInfo on oauth2 and device methods and none on either', () => {
    const userInfo = {
      url: 'https://api.example.com/user',
      idPointer: '/id',
      labelPointer: '/profile/display~1name',
    };
    expect(authMethodSpecSchema.safeParse({ ...oauth, userInfo }).data).toEqual({
      ...oauth,
      userInfo,
    });
    expect(authMethodSpecSchema.safeParse({ ...device, userInfo }).data).toEqual({
      ...device,
      userInfo,
    });
    expect(authMethodSpecSchema.safeParse(oauth).data).toEqual(oauth);
    expect(authMethodSpecSchema.safeParse(device).data).toEqual(device);
  });

  it.each([
    ['an http userInfo url', { url: 'http://api.example.com/user' }],
    ['a relative userInfo url', { url: '/user' }],
    ['an id pointer without a leading slash', { idPointer: 'id' }],
    ['an empty id pointer', { idPointer: '' }],
    ['a label pointer with a bad escape', { labelPointer: '/a~2b' }],
    ['no label pointer', { labelPointer: undefined }],
    ['no id pointer', { idPointer: undefined }],
  ])('rejects %s', (_name, over) => {
    const userInfo = {
      url: 'https://api.example.com/user',
      idPointer: '/id',
      labelPointer: '/login',
      ...over,
    };
    expect(authMethodSpecSchema.safeParse({ ...oauth, userInfo }).success).toBe(false);
    expect(authMethodSpecSchema.safeParse({ ...device, userInfo }).success).toBe(false);
  });

  it.each([
    ['an http authorize url', { ...oauth, authorizeUrl: 'http://example.com/a' }],
    ['a relative token url', { ...oauth, tokenUrl: '/token' }],
    ['pkce false', { ...oauth, pkce: false }],
    ['no client registration', { ...oauth, clientRegistration: [] }],
    ['an unknown client registration', { ...oauth, clientRegistration: ['other'] }],
    ['a non-https revoke url', { ...oauth, revokeUrl: 'ftp://example.com/r' }],
    ['an http device code url', { ...device, deviceCodeUrl: 'http://example.com/d' }],
    ['an unknown kind', { kind: 'basic' }],
    ['a token auth without help', { kind: 'token', form: tokenAuth.form }],
  ])('rejects %s', (_name, auth) => {
    expect(authMethodSpecSchema.safeParse(auth).success).toBe(false);
  });
});

describe('integrationOperationSchema', () => {
  it('accepts a well formed operation', () => {
    expect(integrationOperationSchema.safeParse(op).success).toBe(true);
  });

  it.each([
    ['an uppercase opId', { ...op, opId: 'Get_page' }],
    ['a leading underscore opId', { ...op, opId: '_list' }],
    ['a leading digit opId', { ...op, opId: '2fa_enable' }],
    ['a 41 character opId', { ...op, opId: 'x'.repeat(41) }],
    ['an opId with a dot', { ...op, opId: 'get.page' }],
    ['an opId with a hyphen', { ...op, opId: 'get-page' }],
    ['an unknown access', { ...op, access: 'admin' }],
  ])('rejects %s', (_name, bad) => {
    expect(integrationOperationSchema.safeParse(bad).success).toBe(false);
  });

  it.each([['get_page'], ['x'.repeat(40)]])('accepts the opId %s', (opId) => {
    expect(integrationOperationSchema.safeParse({ ...op, opId }).success).toBe(true);
  });
});

describe('integrationCategorySpecSchema', () => {
  it('accepts a module category with and without a description', () => {
    expect(
      integrationCategorySpecSchema.safeParse({ id: 'module.google.drive-x', label: 'Drive' })
        .success,
    ).toBe(true);
    expect(
      integrationCategorySpecSchema.safeParse({
        id: 'module.google.drive-x',
        label: 'Drive',
        description: 'Cloud drive',
      }).success,
    ).toBe(true);
  });

  it('rejects a bad id and an empty label', () => {
    expect(integrationCategorySpecSchema.safeParse({ id: 'Bad Id', label: 'x' }).success).toBe(
      false,
    );
    expect(integrationCategorySpecSchema.safeParse({ id: 'mail', label: '' }).success).toBe(false);
  });
});
