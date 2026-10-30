import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarNav } from './sidebar-nav';
import { EMPTY_SIDEBAR_TREE } from '@/lib/sidebar-tree';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Renderer,
} from '../../test/render-tree';

// No DOM in this package: the sidebar runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
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
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

const EMAIL = 'user@example.com';
const FEED = 'GET /tasks?status=unfinished&pageSize=100';
const SIGN_OUT_FAILED = 'Could not sign out. Try again.';

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

const sent: string[] = [];

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const url = new URL(String(input), 'http://localhost');
  const call = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
  sent.push(call);
  if (url.pathname === '/tasks') return reply(200, { tasks: [], total: 0 });
  if (call === 'POST /auth/logout') return reply(500, { error: 'busy' });
  return reply(404, { error: `not stubbed: ${call}` });
}

const noop = () => {};

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  sent.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => vi.useRealTimers());

const shell: { mustChangePassword?: boolean } = {};

async function mount(mustChangePassword?: boolean): Promise<Renderer> {
  shell.mustChangePassword = mustChangePassword;
  const view = createRenderer(() => (
    <SidebarNav
      email={EMAIL}
      role="user"
      initialWidthPx={256}
      initialCollapsed={false}
      initialTree={EMPTY_SIDEBAR_TREE}
      initialFilters={[]}
      modules={[]}
      mustChangePassword={shell.mustChangePassword}
    />
  ));
  for (let i = 0; i < 3; i += 1) await view.flush();
  return view;
}

const taskRequests = () => sent.filter((call) => / \/tasks\b/.test(call));
const page = (view: Renderer) => textOf(view.tree());
const hrefs = (view: Renderer) =>
  findAll(view.tree(), (h) => h.tag === 'a').map((h) => h.props.href);

describe('the sidebar while the password must change', () => {
  it('sends no task request and lists no tasks, but keeps the rest of the column', async () => {
    const view = await mount(true);
    vi.advanceTimersByTime(15_000);
    await view.flush();

    expect(taskRequests()).toEqual([]);
    expect(page(view)).not.toContain('Active tasks');
    expect(page(view)).toContain(EMAIL);
    expect(hrefs(view)).toEqual(expect.arrayContaining(['/dashboard', '/settings/account']));
    expect(buttons(view.tree(), 'sign out')).toHaveLength(1);
    expect(findAll(view.tree(), (h) => h.props.role === 'separator')).toHaveLength(1);
  });

  it('starts the poll when the flag turns false, and nothing else resets', async () => {
    const view = await mount(true);
    fire.click(buttons(view.tree(), 'sign out')[0]!);
    await view.flush();
    expect(page(view)).toContain(SIGN_OUT_FAILED);
    vi.advanceTimersByTime(15_000);
    expect(taskRequests()).toEqual([]);

    shell.mustChangePassword = false;
    await view.flush();
    expect(taskRequests()).toEqual([FEED]);
    expect(page(view)).toContain('Active tasks');
    expect(page(view)).toContain(SIGN_OUT_FAILED);

    vi.advanceTimersByTime(5_000);
    await view.flush();
    expect(taskRequests()).toEqual([FEED, FEED]);
  });
});

describe.each([false, undefined])('the sidebar when the flag is %s', (flag) => {
  it('requests the task feed and polls it again after 5 s', async () => {
    const view = await mount(flag);
    expect(taskRequests()).toEqual([FEED]);
    expect(page(view)).toContain('Active tasks');

    vi.advanceTimersByTime(5_000);
    await view.flush();
    expect(taskRequests()).toEqual([FEED, FEED]);
  });
});
