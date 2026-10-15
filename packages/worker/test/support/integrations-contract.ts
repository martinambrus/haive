export const SERVER_NAME = 'haive-integrations';
export const SERVER_PATH = '/haive/haive-integrations-mcp.mjs';
export const TOKEN_PATH = '/haive/haive-integrations.token';
export const API_URL_ENV = 'INTEGRATIONS_MCP_API_URL';
export const UNWIRED_REASON = 'integrations-unwired';

/** Loaded when a test asks for it, so a missing module fails that test and not every test of its file. */
export const integrationsServerModule = () =>
  import('../../src/sandbox/integrations-mcp-server.js');
