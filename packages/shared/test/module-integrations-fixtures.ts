export type Raw = Record<string, any>;

export const OAUTH: Raw = {
  kind: 'oauth2',
  authorizeUrl: 'https://login.fx.example/oauth/authorize',
  tokenUrl: 'https://login.fx.example/oauth/token',
  revokeUrl: 'https://login.fx.example/oauth/revoke',
  scopes: { read: ['docs.read'], write: ['docs.write'] },
  pkce: true,
  clientRegistration: ['preregistered'],
  userInfo: { url: 'https://api.fx.example/userinfo', idPointer: '/sub', labelPointer: '/email' },
};

export const DEVICE: Raw = {
  kind: 'device',
  deviceCodeUrl: 'https://login.fx.example/device/code',
  tokenUrl: 'https://login.fx.example/oauth/token',
  scopes: { read: ['docs.read'], write: ['docs.write'] },
  userInfo: { url: 'https://api.fx.example/userinfo', idPointer: '/sub', labelPointer: '/email' },
};

export const TOKEN: Raw = {
  kind: 'token',
  form: { title: 'Token', fields: [{ id: 'token', type: 'text', label: 'Token' }] },
  help: 'Create a token in the account settings.',
};

export const OPERATION: Raw = {
  opId: 'docs_list',
  description: 'List documents',
  inputSchema: { type: 'object', properties: {} },
  access: 'read',
};

export const without = (value: Raw, key: string): Raw => {
  const { [key]: _dropped, ...rest } = value;
  return rest;
};

export function fixtureProvider(moduleId: string, over: Raw = {}): Raw {
  return {
    id: `module.${moduleId}.crm`,
    displayName: `Provider of ${moduleId}`,
    categories: [`module.${moduleId}.docs`, 'rich-documents'],
    selfHosted: false,
    auth: [OAUTH],
    operations: [OPERATION],
    apiHosts: [`api.${moduleId}.example`],
    ...over,
  };
}

export function fixtureManifest(moduleId = 'fx', over: Raw = {}): Raw {
  return {
    id: moduleId,
    name: `Module ${moduleId}`,
    version: '1.0.0',
    schemaVersion: 1,
    categories: [
      {
        id: `module.${moduleId}.docs`,
        label: `Documents of ${moduleId}`,
        description: `What ${moduleId} files`,
      },
    ],
    integrations: [fixtureProvider(moduleId)],
    ...over,
  };
}

export function fixtureStep(stepId: string, integrations?: Raw[]): Raw {
  return {
    stepId,
    label: stepId,
    group: 'Fixture',
    dispatchesCli: true,
    requires: [],
    provides: [],
    ...(integrations === undefined ? {} : { integrations }),
  };
}

/** Both a manifest and a `{ manifest }` wrapper, so a call pins neither shape of the argument. */
export const asLoadedModule = (manifest: Raw): Raw => ({ ...manifest, manifest });
