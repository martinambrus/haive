// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NewRepoForm } from './new-repo-form';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./filesystem-browser', () => ({ FilesystemBrowser: () => null }));
vi.mock('./credential-modal', () => ({ CredentialModal: () => null }));
vi.mock('./repos/github-oauth-connect', async (original) => ({
  ...(await original<typeof import('./repos/github-oauth-connect')>()),
  GithubOauthConnect: () => null,
}));
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: '',
  api: {
    post,
    get: async (path: string) =>
      path === '/repo-credentials'
        ? { credentials: [{ id: 'c', host: 'github.com', label: 'GitHub OAuth octo' }] }
        : {
            repos: [
              {
                fullName: 'acme/one',
                cloneUrl: 'https://github.com/acme/one.git',
                defaultBranch: 'main',
                private: false,
              },
              {
                fullName: 'acme/two',
                cloneUrl: 'https://github.com/acme/two.git',
                defaultBranch: 'dev',
                private: true,
              },
            ],
            truncated: false,
          },
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('13 selects a repository with arrows and Enter without submitting, closes on Escape and Tab', async () => {
  render(<NewRepoForm />);
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'github_oauth' } });
  const input = await screen.findByRole('combobox', { name: 'Repository' });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  input.focus();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const one = screen.getByRole('option', { name: 'acme/one' });
  expect(input.getAttribute('aria-activedescendant')).toBe(one.id);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const two = screen.getByRole('option', { name: 'acme/two' });
  expect(input.getAttribute('aria-activedescendant')).toBe(two.id);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect((input as HTMLInputElement).value).toBe('acme/two');
  expect((screen.getByLabelText(/Branch/) as HTMLInputElement).value).toBe('dev');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'one' } });
  expect(
    within(screen.getByRole('listbox', { name: 'Repositories' })).getAllByRole('option'),
  ).toHaveLength(1);
  fireEvent.keyDown(input, { key: 'Tab' });
  fireEvent.blur(input);
  expect(screen.queryByRole('listbox')).toBeNull();
});
