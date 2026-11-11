// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CodePreviewDialog } from './code-preview-dialog';
vi.mock('@/lib/api-client', () => ({
  getRepoFile: async () => ({ content: 'const answer = 42;', binary: false }),
}));
afterEach(cleanup);
it('8 gives the code scroller a keyboard stop and accessible name', async () => {
  render(
    <CodePreviewDialog
      repositoryId="r"
      repoPath="src/example.ts"
      symbol={null}
      open
      onOpenChange={() => {}}
    />,
  );
  const region = await screen.findByRole('region', { name: 'Source code: src/example.ts' });
  expect(region.tabIndex).toBe(0);
  expect(screen.getByRole('button', { name: 'Close code preview' })).toBeTruthy();
});
