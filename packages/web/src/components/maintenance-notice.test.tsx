import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MaintenanceNotice } from './maintenance-notice';
import { createRenderer, findAll, fire, textOf, type Renderer } from '../../test/render-tree';

// No DOM in this package: the notice runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('lucide-react', async (importOriginal) =>
  Object.fromEntries(Object.keys(await importOriginal<object>()).map((name) => [name, () => null])),
);

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

let maintenance: 'normal' | 'draining' | 'maintenance' = 'normal';
const sent: string[] = [];

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const call = `${init?.method ?? 'GET'} ${new URL(String(input), 'http://localhost').pathname}`;
  sent.push(call);
  if (call === 'GET /system/state') return reply(200, { globalPause: false, maintenance });
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  maintenance = 'normal';
  sent.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

// What the notice wraps: a page with state of its own, which a remount would reset.
function Page() {
  const [clicks, setClicks] = useState(0);
  return <button onClick={() => setClicks(clicks + 1)}>Clicked {clicks}</button>;
}

const shell: { watch?: boolean; shown: boolean } = { shown: true };
let mounted: Renderer | null = null;

// The poller's timer and subscribers are module state: every test unmounts, so the next one starts clean.
afterEach(() => {
  shell.shown = false;
  mounted?.draw();
  mounted = null;
  vi.useRealTimers();
});

async function mount(watch?: boolean): Promise<Renderer> {
  shell.watch = watch;
  shell.shown = true;
  const view = createRenderer(() =>
    shell.shown ? (
      <MaintenanceNotice role="user" watch={shell.watch}>
        <Page />
      </MaintenanceNotice>
    ) : null,
  );
  mounted = view;
  for (let i = 0; i < 3; i += 1) await view.flush();
  return view;
}

const polls = () => sent.filter((call) => call === 'GET /system/state').length;
const page = (view: Renderer) => textOf(view.tree());
const pageButton = (view: Renderer) => findAll(view.tree(), (h) => h.tag === 'button')[0]!;

describe('the maintenance notice while it is told not to watch', () => {
  it('requests no system state however long it stays mounted, and still shows the page', async () => {
    const view = await mount(false);
    vi.advanceTimersByTime(60_000);
    await view.flush();

    expect(polls()).toBe(0);
    expect(page(view)).toContain('Clicked 0');
  });

  it('polls at once when it is told to watch, and the page it wraps keeps its state', async () => {
    const view = await mount(false);
    fire.click(pageButton(view));
    await view.flush();
    expect(page(view)).toContain('Clicked 1');
    vi.advanceTimersByTime(60_000);
    expect(polls()).toBe(0);

    shell.watch = true;
    await view.flush();
    expect(polls()).toBe(1);
    expect(page(view)).toContain('Clicked 1');

    vi.advanceTimersByTime(15_000);
    await view.flush();
    expect(polls()).toBe(2);
  });

  it('stops polling when it is told to stop, and the page it wraps keeps its state', async () => {
    const view = await mount(true);
    fire.click(pageButton(view));
    await view.flush();
    expect(polls()).toBe(1);

    shell.watch = false;
    await view.flush();
    vi.advanceTimersByTime(60_000);
    await view.flush();
    expect(polls()).toBe(1);
    expect(page(view)).toContain('Clicked 1');
  });
});

describe('the maintenance notice while it watches', () => {
  it.each([true, undefined])(
    'requests the system state at mount and again after 15 s when watch is %s',
    async (watch) => {
      const view = await mount(watch);
      expect(polls()).toBe(1);

      vi.advanceTimersByTime(15_000);
      await view.flush();
      expect(polls()).toBe(2);
    },
  );

  it('still replaces the page for a non-admin in maintenance, and gives it back when it ends', async () => {
    maintenance = 'maintenance';
    const view = await mount(true);
    expect(page(view)).toContain('Haive is being upgraded');
    expect(page(view)).not.toContain('Clicked');

    maintenance = 'normal';
    vi.advanceTimersByTime(15_000);
    await view.flush();
    expect(page(view)).not.toContain('Haive is being upgraded');
    expect(page(view)).toContain('Clicked 0');
  });
});
