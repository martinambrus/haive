// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CliProviderForm } from './cli-provider-form';
import type { CliProvider, CliProviderCatalogEntry } from '@/lib/api-client';
import { IMAGE_BUILDING_REASON, IMAGE_FAILED_REASON } from '@/lib/cli-image-build';

const h = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<object>()),
  api: h,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
const metadata = {
  name: 'claude-code',
  displayName: 'Claude Code',
  defaultExecutable: 'claude',
  defaultAuthMode: 'subscription',
  effortScale: null,
  versionPinnable: false,
  versionCache: null,
} as CliProviderCatalogEntry;
const withStatus = (status: 'building' | 'failed' | 'ready') =>
  ({
    id: 'provider',
    name: 'claude-code',
    label: 'CLI',
    enabled: true,
    sandboxImageBuildStatus: status,
  }) as CliProvider;

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/secrets')) return { secrets: [] };
    return { provider: withStatus('building') };
  });
});
afterEach(cleanup);

async function mount(status: 'building' | 'failed' | 'ready') {
  const onImage = vi.fn();
  const onTest = vi.fn();
  await act(async () => {
    render(
      <CliProviderForm
        mode="edit"
        metadata={metadata}
        provider={withStatus(status)}
        onImageBlockChange={onImage}
        onTestBlockChange={onTest}
      />,
    );
  });
  return { onImage, onTest };
}

it('F1 reports the building reason, the failed reason, or null for a ready image', async () => {
  expect((await mount('building')).onImage).toHaveBeenLastCalledWith(IMAGE_BUILDING_REASON);
  cleanup();
  expect((await mount('failed')).onImage).toHaveBeenLastCalledWith(IMAGE_FAILED_REASON);
  cleanup();
  expect((await mount('ready')).onImage).toHaveBeenLastCalledWith(null);
});

it('F1 keeps unsaved edits out of the image block while the test block says to save', async () => {
  const { onImage, onTest } = await mount('ready');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'renamed' } });
  });
  expect(onTest).toHaveBeenLastCalledWith(expect.stringMatching(/^Unsaved form changes/));
  expect(onImage).toHaveBeenLastCalledWith(null);
  expect(onImage.mock.calls.every(([m]) => m === null)).toBe(true);
});
