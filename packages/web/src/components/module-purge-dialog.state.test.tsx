import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { ModulePurgeDialog } from './module-purge-dialog';
import { Button, Input } from './ui';
import { InlineMarkdown } from './markdown/inline-markdown';
import type { ModulePurgePreview, ModulePurgeResponse } from '@/lib/api-client';

// The same dependency-aware hook-slot approach as the task-type editor controls; no DOM server.
const h = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, effects: [] as (() => void)[] }));
const api = vi.hoisted(() => ({ getModulePurgePreview: vi.fn(), postModulePurge: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = h.next++;
    if (!(at in h.slots)) h.slots[at] = initial;
    return [
      h.slots[at],
      (value: unknown) => {
        h.slots[at] = typeof value === 'function' ? value(h.slots[at]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const at = h.next++;
    if (!(at in h.slots)) h.slots[at] = { current: initial };
    return h.slots[at];
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const at = h.next++;
    const old = h.slots[at] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (
      old &&
      deps.length === old.deps.length &&
      deps.every((value, i) => Object.is(value, old.deps[i]))
    )
      return;
    h.effects.push(() => {
      old?.cleanup?.();
      h.slots[at] = { deps, cleanup: effect() };
    });
  },
}));
vi.mock('@/lib/use-viewer-id', () => ({ useViewerId: () => null }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  ...api,
}));

type Props = ComponentProps<typeof ModulePurgeDialog>;
type El = ReactElement<{
  children?: ReactNode;
  disabled?: boolean;
  body?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
}>;
const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const counts = {
  providerConfigs: 1,
  connections: 2,
  userSettings: 3,
  preferences: 4,
  taskChoices: 5,
  grants: 6,
};
const preview = (moduleId: string): ModulePurgePreview => ({ moduleId, integrations: counts });
const response: ModulePurgeResponse = {
  moduleId: 'alpha',
  database: 'haive_module_alpha',
  configKeysDeleted: 1,
  taskTypesDeleted: [],
  taskTypesKept: [],
  integrationsDeleted: counts,
};

let props: Props;
let key: string | null;
let tree: ReactNode;
function unmount() {
  for (const slot of h.slots) (slot as { cleanup?: () => void })?.cleanup?.();
  h.slots = [];
}
function draw() {
  const wrapper = ModulePurgeDialog(props);
  const nextKey = wrapper?.key ?? null;
  if (nextKey !== key) {
    unmount();
    key = nextKey;
  }
  h.next = 0;
  h.effects = [];
  tree = wrapper ? (wrapper.type as (value: Props) => ReactNode)(wrapper.props) : null;
  for (const effect of h.effects) effect();
}
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  draw();
}
const purge = () =>
  flatten(tree).find((el) => el.type === Button && el.props.children === 'Purge')!;
function typeId(id = 'alpha') {
  flatten(tree).find((el) => el.type === Input)!.props.onChange!({ target: { value: id } });
  draw();
}
const bodies = () =>
  flatten(tree)
    .filter((el) => el.type === InlineMarkdown)
    .map((el) => el.props.body)
    .join('\n');

beforeEach(() => {
  unmount();
  key = null;
  api.getModulePurgePreview.mockReset();
  api.postModulePurge.mockReset();
  props = { target: { id: 'alpha', tornDown: true }, onClose: vi.fn(), onDone: vi.fn() };
});

describe('module purge confirmation requests', () => {
  it('requires a successful current preview as well as the exact typed id', async () => {
    const read = deferred<ModulePurgePreview>();
    api.getModulePurgePreview.mockReturnValue(read.promise);
    draw();
    typeId();
    expect(purge().props.disabled).toBe(true);
    expect(bodies()).toContain('Loading integration counts');
    read.resolve(preview('alpha'));
    await settle();
    expect(purge().props.disabled).toBe(false);
    expect(bodies()).toContain('2 connected accounts');
    typeId('Alpha');
    expect(purge().props.disabled).toBe(true);
  });

  it('keeps failure visible, never shows false zero counts, and enables a successful explicit retry', async () => {
    const first = deferred<ModulePurgePreview>();
    const second = deferred<ModulePurgePreview>();
    api.getModulePurgePreview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    draw();
    typeId();
    first.reject(new Error('Read unavailable'));
    await settle();
    expect(purge().props.disabled).toBe(true);
    expect(bodies()).toContain('counts are unavailable');
    expect(bodies()).not.toContain('0 connected accounts');
    flatten(tree).find((el) => el.type === Button && el.props.children === 'Retry counts')!.props
      .onClick!();
    draw();
    expect(purge().props.disabled).toBe(true);
    second.resolve(preview('alpha'));
    await settle();
    expect(purge().props.disabled).toBe(false);
  });

  it('rejects a response for a different module', async () => {
    api.getModulePurgePreview.mockResolvedValue(preview('beta'));
    draw();
    typeId();
    await settle();
    expect(purge().props.disabled).toBe(true);
    expect(bodies()).toContain('counts are unavailable');
  });

  it('discards a late reply after changing target and resets the typed confirmation', async () => {
    const first = deferred<ModulePurgePreview>();
    const second = deferred<ModulePurgePreview>();
    api.getModulePurgePreview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    draw();
    typeId();
    const signal = api.getModulePurgePreview.mock.calls[0]![1] as AbortSignal;
    props = { ...props, target: { id: 'beta', tornDown: false } };
    draw();
    expect(signal.aborted).toBe(true);
    first.resolve(preview('alpha'));
    await settle();
    expect(purge().props.disabled).toBe(true);
    expect(bodies()).not.toContain('2 connected accounts');
    second.resolve(preview('beta'));
    await settle();
    expect(purge().props.disabled).toBe(true);
    typeId('beta');
    expect(purge().props.disabled).toBe(false);
  });

  it('claims a mutation once and ignores its late success after closing', async () => {
    const mutation = deferred<ModulePurgeResponse>();
    api.getModulePurgePreview.mockResolvedValue(preview('alpha'));
    api.postModulePurge.mockReturnValue(mutation.promise);
    draw();
    typeId();
    await settle();
    const confirm = purge().props.onClick!;
    confirm();
    confirm();
    expect(api.postModulePurge).toHaveBeenCalledTimes(1);
    expect(api.postModulePurge).toHaveBeenCalledWith('alpha', 'alpha');
    props = { ...props, target: null };
    draw();
    mutation.resolve(response);
    await settle();
    expect(props.onDone).not.toHaveBeenCalled();
  });
});
