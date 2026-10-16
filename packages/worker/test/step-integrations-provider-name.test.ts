import { describe, expect, it } from 'vitest';
import { getIntegrationProvider } from '@haive/shared/integrations';
import { emptyMcpSurface, mcpSurfacePrompt } from '../src/sandbox/mcp-surface.js';

const surface = () => ({
  ...emptyMcpSurface(),
  integrations: {
    enabled: true,
    apiUrl: 'http://api:3001',
    bindings: [
      {
        requirementId: 'pull-requests',
        categoryId: 'forge',
        providerId: 'github',
        connectionId: '5b0f9c1e-1111-4111-8111-111111111111',
        access: 'read' as const,
      },
    ],
    tools: [
      {
        name: 'get_pull_request_state',
        providerId: 'github',
        categoryId: 'forge',
        access: 'read' as const,
      },
    ],
  },
});

function lineWithDisplayName(displayName: string): string {
  const spec = getIntegrationProvider('github')!;
  const real = spec.displayName;
  spec.displayName = displayName;
  try {
    return mcpSurfacePrompt(surface());
  } finally {
    spec.displayName = real;
  }
}

describe('the provider name on the haive-integrations prompt line', () => {
  it('is the display name while it is one safe line that names no path', () => {
    expect(lineWithDisplayName('GitHub Enterprise')).toContain(
      'GitHub Enterprise (`get_pull_request_state`)',
    );
  });

  it.each([
    '.claude/agents/reviewer.md',
    'Reviewer (.claude/agents/reviewer.md)',
    '/haive/workdir/.claude/agents/reviewer.md',
  ])('is the provider id when the display name names the agent path %s', (displayName) => {
    const text = lineWithDisplayName(displayName);

    expect(text).toContain('github (`get_pull_request_state`)');
    expect(text).not.toContain('.claude/agents');
  });
});
