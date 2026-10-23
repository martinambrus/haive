import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradeAvailableBanner } from './upgrade-available-banner';
import {
  buttons,
  createRenderer,
  fire,
  isDisabled,
  textOf,
  type Renderer,
} from '../../test/render-tree';

// No DOM in this package: the banner runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
const nav = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (href: string) => {
      nav.pushed.push(href);
    },
  }),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});

const BUSY = 'The repository is busy, try again';
const status = (over: Record<string, unknown> = {}) => ({
  isOnboarded: true,
  hasUpgradeAvailable: true,
  hasInProgressUpgradeSession: false,
  inProgressUpgradeTaskId: null,
  hasPriorUpgrade: true,
  changedTemplateIds: ['a', 'b'],
  obsoleteTemplateIds: [],
  currentTemplateSetHash: 'abcdef012345',
  currentHaiveVersion: '1.2.0',
  installedHaiveVersion: '1.1.0',
  firstUpgradeOnThisInstall: false,
  ...over,
});

let statusReply: { code: number; body: unknown } = { code: 200, body: status() };
let postReply: { code: number; body: unknown } = { code: 409, body: { error: BUSY } };
const sent: string[] = [];
const held: Array<(r: { code: number; body: unknown }) => void> = [];
let holdPosts = false;

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const path = new URL(String(input), 'http://localhost').pathname;
  sent.push(`${init?.method ?? 'GET'} ${path}`);
  if ((init?.method ?? 'GET') === 'GET') return reply(statusReply.code, statusReply.body);
  if (holdPosts) {
    return new Promise((resolve) => held.push((r) => resolve(reply(r.code, r.body))));
  }
  return reply(postReply.code, postReply.body);
}

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('confirm', () => true);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  statusReply = { code: 200, body: status() };
  postReply = { code: 409, body: { error: BUSY } };
  sent.length = 0;
  held.length = 0;
  holdPosts = false;
  nav.pushed.length = 0;
});

async function mount(): Promise<Renderer> {
  const view = createRenderer(() => (
    <UpgradeAvailableBanner repositoryId="repo-1" repositoryName="Alpha" />
  ));
  for (let i = 0; i < 4; i += 1) await view.flush();
  return view;
}

const posts = () => sent.filter((call) => call.startsWith('POST '));
const primary = (view: Renderer) => buttons(view.tree(), /^(review & apply|starting\.\.\.)$/)[0]!;
const rollback = (view: Renderer) => buttons(view.tree(), 'roll back last upgrade')[0]!;

describe('UpgradeAvailableBanner start and rollback failures', () => {
  it('keeps the banner and shows the refusal when the upgrade start answers 409', async () => {
    const view = await mount();
    fire.click(primary(view));
    await view.flush();
    expect(textOf(view.tree())).toContain(BUSY);
    expect(isDisabled(primary(view))).toBe(false);
    expect(rollback(view)).toBeDefined();
  });

  it('retries the start on the next click and clears the message while it runs', async () => {
    const view = await mount();
    fire.click(primary(view));
    await view.flush();
    holdPosts = true;
    fire.click(primary(view));
    view.draw();
    expect(textOf(view.tree())).not.toContain(BUSY);
    expect(posts()).toEqual(['POST /tasks', 'POST /tasks']);
    held[0]!({ code: 200, body: { task: { id: 'task-9' } } });
    await view.flush();
    expect(nav.pushed).toEqual(['/tasks/task-9']);
  });

  it('keeps the banner and shows the refusal when a rollback answers 409', async () => {
    const view = await mount();
    fire.click(rollback(view));
    await view.flush();
    expect(textOf(view.tree())).toContain(BUSY);
    expect(isDisabled(rollback(view))).toBe(false);
    fire.click(rollback(view));
    await view.flush();
    expect(posts()).toEqual([
      'POST /repositories/repo-1/rollback-upgrade',
      'POST /repositories/repo-1/rollback-upgrade',
    ]);
  });

  it('shows a rollback refusal on the up-to-date banner too', async () => {
    statusReply = { code: 200, body: status({ hasUpgradeAvailable: false }) };
    const view = await mount();
    fire.click(rollback(view));
    await view.flush();
    expect(textOf(view.tree())).toContain(BUSY);
    expect(rollback(view)).toBeDefined();
  });

  it('still replaces the banner with the check failure when the status load fails', async () => {
    statusReply = { code: 500, body: { error: 'status exploded' } };
    const view = await mount();
    expect(textOf(view.tree())).toBe('Upgrade check: status exploded');
    expect(buttons(view.tree(), /./)).toEqual([]);
  });
});
