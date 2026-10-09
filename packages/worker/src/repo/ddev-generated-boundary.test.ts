import { describe, expect, it } from 'vitest';
import {
  DDEV_GENERATED_BOUNDARY_MARKER,
  DDEV_GENERATED_BOUNDARY_PROMPT,
  hasLeadingHaiveBlock,
  withDdevGeneratedBoundary,
} from './ddev-generated-boundary.js';

const MCP_BLOCK = '<haive_mcp_surface>\nNo tools are wired into this run.\n</haive_mcp_surface>';

describe('withDdevGeneratedBoundary', () => {
  it('leaves the prompt alone when the invocation has no worktree', () => {
    expect(withDdevGeneratedBoundary('Fix the vhost.', false)).toBe('Fix the vhost.');
  });

  it('adds no second copy to a prompt that already opens with the block', () => {
    const once = withDdevGeneratedBoundary('Fix the vhost.', true);
    expect(once).toBe(`${DDEV_GENERATED_BOUNDARY_PROMPT}\n\nFix the vhost.`);
    expect(withDdevGeneratedBoundary(once, true)).toBe(once);
  });

  it('adds no second copy to a prompt whose block sits behind one applied after it', () => {
    const stored = `${MCP_BLOCK}\n\n${withDdevGeneratedBoundary('Fix the vhost.', true)}`;
    expect(withDdevGeneratedBoundary(stored, true)).toBe(stored);
  });

  it('still adds the block when its marker is quoted in the body', () => {
    const body = [
      'Review this change:',
      '```diff',
      `+export const DDEV_GENERATED_BOUNDARY_MARKER = '${DDEV_GENERATED_BOUNDARY_MARKER}';`,
      '```',
    ].join('\n');
    expect(withDdevGeneratedBoundary(body, true)).toBe(
      `${DDEV_GENERATED_BOUNDARY_PROMPT}\n\n${body}`,
    );
  });

  it('still adds the block when a whole earlier block is quoted in the body', () => {
    const body = `The last run was sent:\n\n${DDEV_GENERATED_BOUNDARY_PROMPT}\n\nand failed.`;
    expect(withDdevGeneratedBoundary(body, true)).toBe(
      `${DDEV_GENERATED_BOUNDARY_PROMPT}\n\n${body}`,
    );
  });
});

describe('hasLeadingHaiveBlock', () => {
  const marker = '<haive_mcp_surface>';
  const block = (name: string): string => `<haive_${name}>\nx\n</haive_${name}>`;

  it.each([
    ['opens the prompt', `${block('mcp_surface')}\n\nBODY`],
    ['is the whole prompt', block('mcp_surface')],
    [
      'sits behind other Haive blocks',
      `${block('app_reach')}\n\n${block('global_kb_index')}\n\n${block('mcp_surface')}\n\nBODY`,
    ],
    [
      'sits behind a block that quotes its own closing tag inline',
      `<haive_app_reach>\nthe \`</haive_app_reach>\` tag\n</haive_app_reach>\n\n${block('mcp_surface')}`,
    ],
  ])('recognises a block that %s', (_where, prompt) => {
    expect(hasLeadingHaiveBlock(prompt, marker)).toBe(true);
  });

  it.each([
    ['is quoted after the body', `BODY\n\n${block('mcp_surface')}`],
    ['is quoted after text that opens the prompt', `Notes:\n${block('mcp_surface')}`],
    ['is named inside another block', `<haive_app_reach>\nsee ${marker}\n</haive_app_reach>`],
    ['sits behind a block that is never closed', `<haive_app_reach>\n${block('mcp_surface')}`],
    ['opens the prompt but is never closed', `${marker}\nBODY`],
    ['is the start of a longer tag', block('mcp_surface_v2')],
    ['is not there', 'BODY'],
    ['is not there in an empty prompt', ''],
  ])('does not take a marker that %s for the block', (_where, prompt) => {
    expect(hasLeadingHaiveBlock(prompt, marker)).toBe(false);
  });
});
