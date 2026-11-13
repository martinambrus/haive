// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MODULE_ID_PATTERN_SOURCE, MODULE_ID_MAX_LENGTH } from '@haive/shared/modularity';
import { ModuleSourceDialog, type ModuleSourceTarget } from './module-source-dialog';
import type { ModuleInstallSource } from '@/lib/api-client';
const api = vi.hoisted(() => ({
  createModuleSource: vi.fn(),
  updateModuleSource: vi.fn(),
  deleteModuleSource: vi.fn(),
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  ...api,
}));
const source = {
  id: 's1',
  kind: 'git',
  moduleId: 'alpha',
  url: 'https://example.com/alpha.git',
  ref: 'main',
  hasToken: true,
  packageName: null,
  version: null,
} as ModuleInstallSource;
function mount(target: ModuleSourceTarget) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<ModuleSourceDialog target={target} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({});
});
afterEach(cleanup);
describe('install source dialog with real React and DOM events', () => {
  it('uses the shared module id limits in the browser input', () => {
    mount({ mode: 'add' });
    const field = screen.getByRole('textbox', { name: 'Module id' }) as HTMLInputElement;
    expect(field.maxLength).toBe(MODULE_ID_MAX_LENGTH);
    const browserPattern = new RegExp(`^(?:${field.pattern})$`, 'v');
    const sharedPattern = new RegExp(`^(?:${MODULE_ID_PATTERN_SOURCE})$`);
    for (const value of [
      'alpha',
      'alpha-2',
      '9',
      'a'.repeat(MODULE_ID_MAX_LENGTH),
      '-alpha',
      'Alpha',
      'alpha_beta',
      'a'.repeat(MODULE_ID_MAX_LENGTH + 1),
    ])
      expect(browserPattern.test(value), value).toBe(sharedPattern.test(value));
    expect(browserPattern.test('alpha-2')).toBe(true);
    expect(browserPattern.test('alpha_beta')).toBe(false);
  });
  it('keeps a stored token blank and omits it from an edit', async () => {
    const view = mount({ mode: 'edit', source });
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Leave blank to keep/)).toBeTruthy();
    submit();
    await waitFor(() =>
      expect(api.updateModuleSource).toHaveBeenCalledWith('s1', {
        kind: 'git',
        moduleId: 'alpha',
        url: source.url,
        ref: 'main',
      }),
    );
    expect(view.onSaved).toHaveBeenCalledOnce();
    expect(view.onClose).toHaveBeenCalledOnce();
  });
  it('sends an explicit clear and disables token replacement', async () => {
    mount({ mode: 'edit', source });
    change('Access token', 'replacement');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Clear stored token' }));
    const token = screen.getByLabelText('Access token') as HTMLInputElement;
    expect(token.value).toBe('');
    expect(token.disabled).toBe(true);
    submit();
    await waitFor(() =>
      expect(api.updateModuleSource.mock.calls[0]?.[1]).toMatchObject({ clearToken: true }),
    );
    expect(api.updateModuleSource.mock.calls[0]![1]).not.toHaveProperty('token');
  });
  it('offers only a Git repository when adding a source', async () => {
    mount({ mode: 'add' });
    expect(screen.queryByRole('option', { name: 'Registry package' })).toBeNull();
    expect(screen.queryByLabelText('Exact version')).toBeNull();
    change('Module id', 'beta');
    change('HTTPS repository URL', 'https://example.com/beta.git');
    submit();
    await waitFor(() =>
      expect(api.createModuleSource).toHaveBeenCalledWith({
        kind: 'git',
        moduleId: 'beta',
        url: 'https://example.com/beta.git',
        ref: 'main',
      }),
    );
  });
  it('waits for confirmation before deletion and supports the shared dialog close path', async () => {
    const view = mount({ mode: 'delete', source });
    expect(api.deleteModuleSource).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view.onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Delete source' }));
    await waitFor(() => expect(api.deleteModuleSource).toHaveBeenCalledWith('s1'));
  });
  it('deletes an unsupported stored registry source without rendering edit fields', async () => {
    mount({
      mode: 'delete',
      source: {
        ...source,
        kind: 'registry',
        url: null,
        ref: null,
        packageName: '@haive-module/alpha',
        version: '1.2.3',
      },
    });
    expect(screen.queryByLabelText('HTTPS repository URL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete source' }));
    await waitFor(() => expect(api.deleteModuleSource).toHaveBeenCalledWith('s1'));
  });
  it('refuses editing an unsupported stored registry source', () => {
    mount({ mode: 'edit', source: { ...source, kind: 'registry' } });
    expect(screen.getByText(/Unsupported source kind/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save source' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByLabelText('HTTPS repository URL')).toBeNull();
  });
  it('keeps a failed save open and shows the error', async () => {
    api.updateModuleSource.mockRejectedValue(new Error('A source already exists'));
    const view = mount({ mode: 'edit', source });
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('A source already exists');
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
  });
});
