import type { IntegrationOperation, IntegrationProviderSpec } from '../modularity/integrations.js';
import {
  BODY_MAX_LENGTH,
  BRANCH_MAX_LENGTH,
  PR_NUMBER_PATTERN,
  TITLE_MAX_LENGTH,
  TITLE_MIN_LENGTH,
} from './op-args.js';

const OPEN_PULL_REQUEST: IntegrationOperation = {
  opId: 'open_pull_request',
  description:
    'Open a pull request (merge request), or return the existing one for the branch pair',
  inputSchema: {
    type: 'object',
    properties: {
      head: {
        type: 'string',
        maxLength: BRANCH_MAX_LENGTH,
        description: 'Source (feature) branch',
      },
      base: { type: 'string', maxLength: BRANCH_MAX_LENGTH, description: 'Target (base) branch' },
      title: { type: 'string', minLength: TITLE_MIN_LENGTH, maxLength: TITLE_MAX_LENGTH },
      body: { type: 'string', maxLength: BODY_MAX_LENGTH },
    },
    required: ['head', 'base', 'title', 'body'],
    additionalProperties: false,
  },
  access: 'write',
};

const GET_PULL_REQUEST_STATE: IntegrationOperation = {
  opId: 'get_pull_request_state',
  description: 'Read the lifecycle state (open, merged, closed) of a pull request',
  inputSchema: {
    type: 'object',
    properties: {
      prNumber: {
        type: 'string',
        pattern: PR_NUMBER_PATTERN,
        description: 'Forge PR identifier, as returned by open_pull_request',
      },
    },
    required: ['prNumber'],
    additionalProperties: false,
  },
  access: 'read',
};

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_INFO = {
  url: 'https://api.github.com/user',
  idPointer: '/id',
  labelPointer: '/login',
};

function tokenAuth(
  title: string,
  label: string,
  help: string,
): IntegrationProviderSpec['auth'][number] {
  return {
    kind: 'token',
    form: { title, fields: [{ id: 'token', type: 'text', label, required: true }] },
    help,
  };
}

function forge(
  id: string,
  displayName: string,
  selfHosted: boolean,
  token: IntegrationProviderSpec['auth'][number],
  extraAuth: IntegrationProviderSpec['auth'] = [],
): IntegrationProviderSpec {
  return {
    id,
    displayName,
    categories: ['forge'],
    selfHosted,
    auth: [token, ...extraAuth],
    operations: [OPEN_PULL_REQUEST, GET_PULL_REQUEST_STATE],
  };
}

export const CORE_FORGE_PROVIDER_SPECS: IntegrationProviderSpec[] = [
  forge(
    'github',
    'GitHub',
    false,
    tokenAuth(
      'GitHub personal access token',
      'Personal access token',
      'Create a personal access token and grant it read and write access to Pull requests and Contents on the repository (classic token: the repo scope).',
    ),
    [
      {
        kind: 'device',
        deviceCodeUrl: 'https://github.com/login/device/code',
        tokenUrl: GITHUB_TOKEN_URL,
        scopes: { read: ['repo'], write: ['repo'] },
        userInfo: GITHUB_USER_INFO,
      },
      {
        kind: 'oauth2',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: GITHUB_TOKEN_URL,
        scopes: { read: ['repo'], write: ['repo'] },
        pkce: true,
        clientRegistration: ['preregistered'],
        userInfo: GITHUB_USER_INFO,
      },
    ],
  ),
  forge(
    'gitea',
    'Gitea',
    true,
    tokenAuth(
      'Gitea access token',
      'Access token',
      'Create an access token under Settings, Applications and grant it read and write on repository.',
    ),
  ),
  forge(
    'gitlab',
    'GitLab',
    true,
    tokenAuth(
      'GitLab personal access token',
      'Personal access token',
      'Create a personal or project access token with the api scope and at least the Developer role.',
    ),
  ),
  forge(
    'bitbucket_cloud',
    'Bitbucket Cloud',
    false,
    tokenAuth(
      'Bitbucket app password',
      'App password',
      'Create an app password and grant it Pull requests: Read and Write and Repositories: Read. It is used with the credential username.',
    ),
  ),
  forge(
    'bitbucket_server',
    'Bitbucket Server',
    true,
    tokenAuth(
      'Bitbucket Server personal access token',
      'Personal access token',
      'Create an HTTP access token with Project read and Repository write permission.',
    ),
  ),
];
