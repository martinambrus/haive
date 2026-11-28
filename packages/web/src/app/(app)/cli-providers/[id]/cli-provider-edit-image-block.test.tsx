import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRenderer } from '../../../../../test/render-tree';
import EditCliProviderPage from './page';
import { IMAGE_BUILDING_REASON } from '@/lib/cli-image-build';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'a' }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
const seen = vi.hoisted(() => ({
  form: {} as Record<string, unknown>,
  test: {} as Record<string, unknown>,
}));
vi.mock('@/components/cli-provider-form', () => ({
  CliProviderForm: (props: Record<string, unknown>) => {
    seen.form = props;
    return null;
  },
}));
vi.mock('@/components/cli-provider-test', () => ({
  CliProviderTest: (props: Record<string, unknown>) => {
    seen.test = props;
    return null;
  },
}));
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: h,
}));

beforeEach(() => {
  vi.useFakeTimers();
  const provider = {
    id: 'a',
    userId: 'u',
    name: 'codex',
    label: 'Row a',
    enabled: true,
    authMode: 'subscription',
    authStatus: 'ok',
    envVars: {},
    cliArgs: [],
  };
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers/a') return { provider };
    if (path === '/cli-providers/catalog')
      return { providers: [{ name: 'codex', description: 'd', defaultExecutable: 'codex' }] };
    if (path === '/cli-providers') return { providers: [provider] };
    return { snapshots: [] };
  });
});
afterEach(() => vi.useRealTimers());

it('E1 hands the form image block to the test card as its Log in block', async () => {
  const view = createRenderer(() => createElement(EditCliProviderPage));
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  expect(seen.test.loginBlockMessage ?? null).toBeNull();
  (seen.form.onImageBlockChange as (m: string | null) => void)(IMAGE_BUILDING_REASON);
  view.draw();
  expect(seen.test.loginBlockMessage).toBe(IMAGE_BUILDING_REASON);
  (seen.form.onImageBlockChange as (m: string | null) => void)(null);
  view.draw();
  expect(seen.test.loginBlockMessage ?? null).toBeNull();
});
