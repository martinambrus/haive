// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CliProvider, CliProviderCatalogEntry } from '@/lib/api-client';
import EditCliProviderPage from './page';

const h = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<object>()),
  api: h,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'provider' }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
vi.mock('@/components/cli-provider-test', () => ({ CliProviderTest: () => null }));

const metadata = {
  name: 'claude-code',
  displayName: 'Claude Code',
  defaultExecutable: 'claude',
  defaultAuthMode: 'subscription',
  effortScale: null,
  versionPinnable: false,
  versionCache: null,
  installSupported: true,
} as CliProviderCatalogEntry;
let provider: CliProvider;
let connected: boolean;
beforeEach(() => {
  vi.resetAllMocks();
  provider = {
    id: 'provider',
    name: 'claude-code',
    label: 'Claude',
    authMode: 'subscription',
    isolateAuth: false,
    enabled: true,
    envVars: {},
    cliArgs: [],
    sandboxImageBuildStatus: 'idle',
  } as unknown as CliProvider;
  connected = false;
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers/provider') return { provider };
    if (path === '/cli-providers') return { providers: [provider] };
    if (path === '/cli-providers/catalog') return { providers: [metadata] };
    if (path.endsWith('/secrets')) return { secrets: [] };
    if (path.endsWith('/usage-auth')) return { connected, connectedAt: null };
    if (path === '/usage-window')
      return {
        snapshots: connected ? [{ providerId: provider.id, status: 'needs_reconnect' }] : [],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  h.patch.mockImplementation(async (_path: string, payload: Partial<CliProvider>) => {
    provider = { ...provider, ...payload };
    return { provider };
  });
  h.post.mockResolvedValue({});
});
afterEach(cleanup);

async function mount() {
  await act(async () => {
    render(<EditCliProviderPage />);
  });
}
async function save(action: 'Save' | 'Rebuild image') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: action }));
  });
}

it.each([
  ['Save', 'api_key', 'subscription'],
  ['Save', 'subscription', 'api_key'],
  ['Rebuild image', 'api_key', 'subscription'],
  ['Rebuild image', 'subscription', 'api_key'],
] as const)('%s refreshes usage controls after %s → %s', async (action, from, to) => {
  provider.authMode = from;
  await mount();
  expect(screen.queryByRole('button', { name: 'Connect usage tracking' }) !== null).toBe(
    from === 'subscription',
  );
  fireEvent.change(screen.getByLabelText('Authentication mode'), { target: { value: to } });
  // Unsaved edits must not change the usage card's view of the persisted provider.
  expect(screen.queryByRole('button', { name: 'Connect usage tracking' }) !== null).toBe(
    from === 'subscription',
  );
  await save(action);
  expect(h.patch).toHaveBeenCalledWith(
    '/cli-providers/provider',
    expect.objectContaining({ authMode: to }),
  );
  expect(screen.queryByRole('button', { name: 'Connect usage tracking' }) !== null).toBe(
    to === 'subscription',
  );
  if (action === 'Rebuild image')
    expect(h.post).toHaveBeenCalledWith('/cli-providers/provider/sandbox-image/build');
});

it.each(['Save', 'Rebuild image'] as const)(
  '%s refreshes the usage Disconnect scope after isolating auth',
  async (action) => {
    connected = true;
    await mount();
    const notice = () => screen.getByText(/Token expired/).textContent;
    expect(notice()).toContain('every row');
    fireEvent.click(screen.getByLabelText('Isolate auth from other claude-code providers'));
    await save(action);
    expect(notice()).toContain('this row');
    expect(notice()).not.toContain('every row');
  },
);

it('keeps the persisted usage controls when the provider save is refused', async () => {
  provider.authMode = 'api_key';
  h.patch.mockRejectedValue(Object.assign(new Error('Authentication busy'), { status: 409 }));
  await mount();
  fireEvent.change(screen.getByLabelText('Authentication mode'), {
    target: { value: 'subscription' },
  });
  await save('Rebuild image');
  expect(screen.queryByRole('button', { name: 'Connect usage tracking' })).toBeNull();
  expect(h.post).not.toHaveBeenCalled();
});

it('refreshes saved auth settings even when starting the image build fails', async () => {
  provider.authMode = 'api_key';
  h.post.mockRejectedValue(Object.assign(new Error('Build unavailable'), { status: 503 }));
  await mount();
  fireEvent.change(screen.getByLabelText('Authentication mode'), {
    target: { value: 'subscription' },
  });
  await save('Rebuild image');
  expect(screen.queryByRole('button', { name: 'Connect usage tracking' })).not.toBeNull();
});

it.each(['Save', 'Rebuild image'] as const)(
  '%s refreshes committed auth settings even when a later secret write fails',
  async (action) => {
    provider.authMode = 'api_key';
    h.post.mockRejectedValue(
      Object.assign(new Error('Authentication busy'), { status: 409, code: 'cli_auth_busy' }),
    );
    await mount();
    fireEvent.change(screen.getByLabelText('Authentication mode'), {
      target: { value: 'subscription' },
    });
    // This random fixture is never sent outside the mocked API.
    fireEvent.change(screen.getByLabelText('Secrets'), {
      target: { value: `ANTHROPIC_API_KEY=${crypto.randomUUID()}` },
    });
    await save(action);
    expect(screen.queryByRole('button', { name: 'Connect usage tracking' })).not.toBeNull();
    expect(h.post).toHaveBeenCalledWith(
      '/cli-providers/provider/secrets',
      expect.objectContaining({ secretName: 'ANTHROPIC_API_KEY' }),
    );
    expect(h.post).not.toHaveBeenCalledWith('/cli-providers/provider/sandbox-image/build');
  },
);
