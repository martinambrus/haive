import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { Dialog } from '@/components/dialog';
import { FormError, Input } from '@/components/ui';
import { ModuleSourceDialog, type ModuleSourceTarget } from './module-source-dialog';
import type { ModuleInstallSource } from '@/lib/api-client';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0 }));
const api = vi.hoisted(() => ({
  createModuleSource: vi.fn(),
  updateModuleSource: vi.fn(),
  deleteModuleSource: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = initial;
    return [
      hooks.slots[at],
      (value: unknown) => {
        hooks.slots[at] = value;
      },
    ];
  },
}));

type El = ReactElement<{
  children?: ReactNode;
  id?: string;
  body?: string;
  message?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
}>;
const flat = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flat)
    : isValidElement<El['props']>(node)
      ? [node, ...flat(node.props.children)]
      : [];
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
  let tree: ReactNode;
  const draw = () => {
    hooks.next = 0;
    tree = ModuleSourceDialog({ target, onClose, onSaved });
  };
  const field = (id: string) => flat(tree).find((e) => e.props.id === id)!;
  draw();
  return {
    draw,
    field,
    onClose,
    onSaved,
    elements: () => flat(tree),
    change: (id: string, value: string) => {
      field(id).props.onChange!({ target: { value, checked: false } });
      draw();
    },
    submit: async () => {
      await flat(tree).find((e) => e.type === 'form')!.props.onSubmit!({
        preventDefault: () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      draw();
    },
    closeFromDialog: () => {
      (
        flat(tree).find((e) => e.type === Dialog)! as unknown as ReactElement<
          ComponentProps<typeof Dialog>
        >
      ).props.onOpenChange(false);
    },
  };
}
beforeEach(() => {
  hooks.slots = [];
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({});
});
describe('install source dialog', () => {
  it('keeps a stored token blank and omits it from an edit', async () => {
    const view = mount({ mode: 'edit', source });
    expect(view.field('source-token').type).toBe(Input);
    expect(view.field('source-token').props.value).toBe('');
    expect(view.elements().some((e) => e.props.body?.includes('Leave blank to keep'))).toBe(true);
    await view.submit();
    expect(api.updateModuleSource).toHaveBeenCalledWith('s1', {
      kind: 'git',
      moduleId: 'alpha',
      url: source.url,
      ref: 'main',
    });
    expect(view.onSaved).toHaveBeenCalledOnce();
    expect(view.onClose).toHaveBeenCalledOnce();
  });
  it('sends an explicit clear and disables token replacement', async () => {
    const view = mount({ mode: 'edit', source });
    view.change('source-token', 'replacement');
    view.elements().find((e) => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange!(
      {
        target: { value: '', checked: true },
      },
    );
    view.draw();
    expect(view.field('source-token').props.value).toBe('');
    expect(view.field('source-token').props.disabled).toBe(true);
    await view.submit();
    expect(api.updateModuleSource.mock.calls[0]![1]).toMatchObject({ clearToken: true });
    expect(api.updateModuleSource.mock.calls[0]![1]).not.toHaveProperty('token');
  });
  it('records the exact registry package and replacement token', async () => {
    const view = mount({ mode: 'add' });
    view.change('source-kind', 'registry');
    view.change('source-module-id', 'beta');
    view.change('source-version', '1.2.3');
    view.change('source-token', 'new-token');
    await view.submit();
    expect(api.createModuleSource).toHaveBeenCalledWith({
      kind: 'registry',
      moduleId: 'beta',
      packageName: '@haive-module/beta',
      version: '1.2.3',
      token: 'new-token',
    });
  });
  it('waits for confirmation before deletion and supports the shared dialog close path', async () => {
    const view = mount({ mode: 'delete', source });
    expect(api.deleteModuleSource).not.toHaveBeenCalled();
    view.closeFromDialog();
    expect(view.onClose).toHaveBeenCalledOnce();
    await view.submit();
    expect(api.deleteModuleSource).toHaveBeenCalledWith('s1');
  });
  it('keeps a failed save open and shows the error', async () => {
    api.updateModuleSource.mockRejectedValue(new Error('A source already exists'));
    const view = mount({ mode: 'edit', source });
    await view.submit();
    expect(view.elements().find((e) => e.type === FormError)!.props.message).toBe(
      'A source already exists',
    );
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
  });
});
