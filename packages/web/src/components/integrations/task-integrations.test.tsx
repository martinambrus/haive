import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskIntegrations } from './task-integrations';
import {
  buttons,
  controls,
  createRenderer,
  fire,
  textOf,
  valueOf,
  type Renderer,
} from '../../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/inline-markdown', () => ({
  InlineMarkdown: ({ body }: { body: string }) => <p>{body}</p>,
}));
const api = vi.hoisted(() => ({
  getTaskIntegrations: vi.fn(),
  getIntegrationCategories: vi.fn(),
  listIntegrationProviders: vi.fn(),
  listIntegrationConnections: vi.fn(),
  saveTaskIntegration: vi.fn(),
  resetTaskIntegration: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);

const row = {
  categoryId: 'module.acme.docs',
  status: 'resolved',
  providerId: 'module.acme.docs',
  connectionId: 'a',
  source: 'task',
  candidates: ['a', 'b'],
  skipped: [],
};
const choice = { categoryId: row.categoryId, providerId: row.providerId, connectionId: 'a' };
const snapshot = () => ({ categories: [{ ...row }], choices: [{ ...choice }], grants: [] });
let data = snapshot();
let props = { taskId: 't1', status: 'running', dead: false };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async (view: Renderer) => {
  for (let i = 0; i < 4; i++) await view.flush();
};
const mount = async () => {
  const view = createRenderer(() => <TaskIntegrations {...props} />);
  await flush(view);
  return view;
};
const button = (view: Renderer, name: string | RegExp) =>
  buttons(view.tree(), typeof name === 'string' ? name.toLowerCase() : name)[0]!;
const field = (view: Renderer, name: string | RegExp) =>
  controls(view.tree(), typeof name === 'string' ? name.toLowerCase() : name)[0]!;
const change = (view: Renderer, name: string | RegExp, value: string) => {
  fire.type(field(view, name), value);
  view.draw();
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  data = snapshot();
  props = { taskId: 't1', status: 'running', dead: false };
  api.getTaskIntegrations.mockImplementation(async () => structuredClone(data));
  api.getIntegrationCategories.mockResolvedValue({
    categories: [{ id: row.categoryId, label: 'Documents' }],
  });
  api.listIntegrationProviders.mockResolvedValue({
    providers: [
      { id: row.providerId, displayName: 'Acme Docs', categories: [row.categoryId], enabled: true },
    ],
  });
  api.listIntegrationConnections.mockResolvedValue({
    connections: [
      { id: 'a', providerId: row.providerId, accountLabel: 'Work account', status: 'connected' },
      {
        id: 'b',
        providerId: row.providerId,
        accountLabel: 'Personal account',
        status: 'needs_reauth',
      },
      {
        id: 'outside',
        providerId: row.providerId,
        accountLabel: 'Outside repository allow-list',
        status: 'connected',
      },
    ],
  });
  api.saveTaskIntegration.mockResolvedValue({});
  api.resetTaskIntegration.mockResolvedValue({});
});

describe('task integration controls', () => {
  it('shows current resolution, raw override and eligible owned account status, including module category labels', async () => {
    const view = await mount();
    const text = textOf(view.tree());
    expect(text).toContain('Source: task override');
    expect(text).toContain('Task override: Acme Docs');
    expect(text).toContain('Personal account (Needs reconnecting)');
    expect(text).not.toContain('Outside repository');
    expect(field(view, 'Also for my later tasks').props.checked).toBe(false);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('a');
  });
  it('saves the selected account without implicit remember and reloads server state', async () => {
    const view = await mount();
    change(view, 'Account for Documents', 'b');
    await fire.click(button(view, 'Save Documents override'));
    await flush(view);
    expect(api.saveTaskIntegration.mock.calls).toEqual([
      ['t1', row.categoryId, { providerId: row.providerId, connectionId: 'b' }],
    ]);
    expect(api.getTaskIntegrations).toHaveBeenCalledTimes(2);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('a'); // server, rather than the submitted draft, is canonical
  });
  it('remembers only when explicitly checked and unchecks consent after confirmation', async () => {
    const view = await mount();
    fire.check(field(view, 'Also for my later tasks'), true);
    view.draw();
    await fire.click(button(view, 'Save Documents override'));
    await flush(view);
    expect(api.saveTaskIntegration).toHaveBeenCalledWith('t1', row.categoryId, {
      providerId: row.providerId,
      connectionId: 'a',
      remember: true,
    });
    expect(field(view, 'Also for my later tasks').props.checked).toBe(false);
  });
  it('resets task choice and retained grant through DELETE; preference clearing requires separate consent', async () => {
    const view = await mount();
    await fire.click(button(view, 'Reset Documents to automatic'));
    await flush(view);
    expect(api.resetTaskIntegration).toHaveBeenLastCalledWith('t1', row.categoryId, false);
    fire.check(field(view, 'Also clear my remembered preference for Documents'), true);
    view.draw();
    await fire.click(button(view, 'Reset Documents to automatic'));
    await flush(view);
    expect(api.resetTaskIntegration).toHaveBeenLastCalledWith('t1', row.categoryId, true);
  });
  it('keeps unavailable explicit provider and account visible across Refresh and allows reset', async () => {
    data.choices[0] = { ...choice, providerId: 'module.gone.docs', connectionId: 'gone' };
    data.categories[0] = {
      ...row,
      status: 'unresolved',
      providerId: 'module.gone.docs',
      connectionId: 'gone',
      reason: 'provider-missing',
    } as typeof row;
    const view = await mount();
    expect(valueOf(field(view, 'Provider for Documents'))).toBe('module.gone.docs');
    expect(valueOf(field(view, 'Account for Documents'))).toBe('gone');
    expect(textOf(view.tree())).toContain('provider-missing');
    await fire.click(button(view, 'Refresh'));
    await flush(view);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('gone');
    await fire.click(button(view, 'Reset Documents to automatic'));
    expect(api.resetTaskIntegration).toHaveBeenCalledTimes(1);
  });
  it('retains refused drafts and never claims an unconfirmed save', async () => {
    api.saveTaskIntegration.mockRejectedValue(new Error('Account no longer fits this repository'));
    const view = await mount();
    change(view, 'Account for Documents', 'b');
    await fire.click(button(view, 'Save Documents override'));
    await flush(view);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('b');
    expect(textOf(view.tree())).toContain('Account no longer fits this repository');
    expect(textOf(view.tree())).not.toContain('Saved.');
    await fire.click(button(view, 'Refresh'));
    await flush(view);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('b');
  });
  it.each(['completed', 'cancelled', 'dead'])(
    'blocks save/reset for %s, including a captured click handler after a status poll',
    async (state) => {
      const view = await mount();
      const save = button(view, 'Save Documents override').props.onClick as () => void;
      props = { ...props, status: state === 'dead' ? 'running' : state, dead: state === 'dead' };
      view.draw();
      save();
      await flush(view);
      expect(api.saveTaskIntegration).not.toHaveBeenCalled();
      expect(api.resetTaskIntegration).not.toHaveBeenCalled();
      expect(button(view, 'Save Documents override').props.disabled).toBe(true);
      expect(button(view, 'Reset Documents to automatic').props.disabled).toBe(true);
    },
  );
  it('bounds duplicate clicks and cannot re-enable a task that ends during a mutation', async () => {
    const pending = deferred<object>();
    api.saveTaskIntegration.mockReturnValue(pending.promise);
    const view = await mount();
    const click = button(view, 'Save Documents override').props.onClick as () => void;
    click();
    click();
    view.draw();
    expect(api.saveTaskIntegration).toHaveBeenCalledTimes(1);
    props = { ...props, status: 'completed' };
    view.draw();
    pending.resolve({});
    await flush(view);
    expect(button(view, 'Save Documents override').props.disabled).toBe(true);
  });
  it('discards old task replies across route changes and mutations', async () => {
    const pending = deferred<ReturnType<typeof snapshot>>();
    api.getTaskIntegrations.mockReturnValueOnce(pending.promise);
    const view = createRenderer(() => <TaskIntegrations {...props} />);
    view.draw();
    props = { ...props, taskId: 't2' };
    await flush(view);
    const obsolete = snapshot();
    obsolete.choices[0]!.connectionId = 'old-task';
    pending.resolve(obsolete);
    await flush(view);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('a');
    await fire.click(button(view, 'Save Documents override'));
    expect(api.saveTaskIntegration.mock.calls[0]![0]).toBe('t2');
  });
  it('discards an older Refresh reply after a newer load and preserves a changed account draft', async () => {
    const view = await mount();
    change(view, 'Account for Documents', 'b');
    const pending = deferred<ReturnType<typeof snapshot>>();
    api.getTaskIntegrations.mockReturnValueOnce(pending.promise);
    const refresh = button(view, 'Refresh').props.onClick as () => void;
    refresh();
    refresh();
    await flush(view);
    const old = snapshot();
    old.choices[0]!.connectionId = 'obsolete';
    pending.resolve(old);
    await flush(view);
    expect(valueOf(field(view, 'Account for Documents'))).toBe('b');
    expect(textOf(view.tree())).not.toContain('obsolete');
  });
  it('allows a deliberate provider-only override without substituting an account', async () => {
    const view = await mount();
    change(view, 'Account for Documents', '');
    await fire.click(button(view, 'Save Documents override'));
    await flush(view);
    expect(api.saveTaskIntegration).toHaveBeenCalledWith('t1', row.categoryId, {
      providerId: row.providerId,
      connectionId: null,
    });
  });
  it('keeps loading failures recoverable through Refresh and renders unknown reasons', async () => {
    api.getTaskIntegrations.mockRejectedValueOnce(new Error('Task temporarily unavailable'));
    const view = await mount();
    expect(textOf(view.tree())).toContain('Task temporarily unavailable');
    data.categories[0] = { ...row, status: 'unresolved', reason: 'future-reason' } as typeof row;
    await fire.click(button(view, 'Refresh'));
    await flush(view);
    expect(textOf(view.tree())).toContain('future-reason');
  });
});
