import { afterEach, expect, it, vi } from 'vitest';
import { OllamaModelDownload } from './ollama-model-download';
import { OllamaTestButton } from './connection-tester';
import { buttons, createRenderer, fire, textOf } from '../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: 'http://localhost:3001',
  api: { post: async () => ({ ok: true, reachable: true, modelFound: false }) },
}));
afterEach(() => vi.unstubAllGlobals());
const MESSAGE =
  'This model is not configured in your providers or Global KB. Ask an administrator to allow it.';

it.each(['provider', 'onboarding'])(
  'shows the server’s 403 reason in the %s pull caller',
  async (caller) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: MESSAGE }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const view = createRenderer(() =>
      caller === 'provider' ? (
        <OllamaModelDownload model="qwen3" ollamaUrl="http://ollama:11434" />
      ) : (
        <OllamaTestButton
          formValues={{ ollamaUrl: 'http://ollama:11434', embeddingModel: 'qwen3' }}
        />
      ),
    );
    await view.flush();
    if (caller === 'onboarding') {
      fire.click(buttons(view.tree(), /test ollama/i)[0]!);
      await view.flush();
    }
    fire.click(buttons(view.tree(), /download model|^pull /i)[0]!);
    await view.flush();
    expect(textOf(view.tree())).toContain(MESSAGE);
    expect(textOf(view.tree())).not.toContain('is ready');
  },
);
