// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CliProviderForm } from './cli-provider-form';
import type { CliProvider, CliProviderCatalogEntry } from '@/lib/api-client';

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
const provider = {
  id: 'provider',
  name: 'claude-code',
  label: 'CLI',
  enabled: true,
} as CliProvider;
beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/disable-impact')) return { taskCount: 2, stepCount: 3 };
    if (path.endsWith('/secrets')) return { secrets: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  h.patch.mockResolvedValue({});
});
afterEach(cleanup);
async function saveDisabled() {
  await act(async () => {
    render(<CliProviderForm mode="edit" metadata={metadata} provider={provider} />);
  });
  fireEvent.click(screen.getByLabelText('Enabled'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
}
it('shows server impact before disabling, and writes only after confirmation', async () => {
  await saveDisabled();
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('2 tasks');
  expect(dialog.textContent).toContain('3 remaining steps');
  expect(h.patch).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable provider' }));
  });
  expect(h.patch).toHaveBeenCalledWith(
    '/cli-providers/provider',
    expect.objectContaining({ enabled: false }),
  );
});
it('cancels a disable without writing', async () => {
  await saveDisabled();
  const dialog = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });
  expect(h.patch).not.toHaveBeenCalled();
});

it('also confirms before a rebuild persists an unsaved disable', async () => {
  await act(async () => {
    render(<CliProviderForm mode="edit" metadata={metadata} provider={provider} />);
  });
  fireEvent.click(screen.getByLabelText('Enabled'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild image' }));
  });
  expect(h.patch).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.post).not.toHaveBeenCalled();
});
