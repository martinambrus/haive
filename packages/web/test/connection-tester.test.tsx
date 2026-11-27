// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OllamaTestButton } from '../src/components/connection-tester';

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { post: h.post } }));
afterEach(() => {
  cleanup();
  h.post.mockReset();
});

it('renders the tooling timeout reply as reachable with an embedding-check failure', async () => {
  // The complete API reply, including the tags result retained when the embed times out.
  h.post.mockResolvedValue({
    ok: true,
    reachable: true,
    modelCount: 1,
    modelFound: true,
    models: ['embed'],
    dims: null,
    dimsMatch: null,
    expectedDims: 2,
    dimsError: 'Embedding probe timed out; try again.',
    code: 'ollama_probe_timeout',
    retryable: true,
  });
  const { container } = render(
    <OllamaTestButton
      formValues={{
        ollamaUrl: 'http://embed.example',
        embeddingModel: 'embed',
        embeddingDimensions: 2,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Test Ollama + model' }));
  expect(
    await screen.findByText('Embedding check failed: Embedding probe timed out; try again.'),
  ).toBeTruthy();
  expect(container.textContent).toContain('Ollama reachable (1 model).');
  expect(container.textContent).toContain('Model "embed" found.');
  expect(container.textContent).not.toContain('undefined');
  expect(container.textContent).not.toContain('unreachable');
  expect(h.post).toHaveBeenCalledWith('/tooling/test-ollama', {
    ollamaUrl: 'http://embed.example',
    model: 'embed',
    dimensions: 2,
  });
});
