import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BundleComposer } from './bundle-composer';
import {
  createRenderer,
  findAll,
  fire,
  textOf,
  type Host,
  type Renderer,
} from '../../test/render-tree';

const updaterReplay = vi.hoisted(() => ({ enabled: false }));

// No DOM in this package: render-tree keeps the hooks and fetch supplies the network.
vi.mock('react', async (importOriginal) => {
  const { reactHooks } = await import('../../test/render-tree');
  return {
    ...(await importOriginal<typeof import('react')>()),
    ...reactHooks,
    useState(initial: unknown) {
      const [value, set] = reactHooks.useState(initial);
      const setState = set as (update: unknown) => void;
      return [
        value,
        (update: unknown) => {
          if (updaterReplay.enabled && typeof update === 'function') {
            // Replay the updater with the same input, as StrictMode may do. This
            // pins updater purity; the harness does not render React StrictMode.
            setState((previous: unknown) => {
              update(previous);
              return update(previous);
            });
          } else {
            setState(update);
          }
        },
      ];
    },
  };
});

const reply = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => structuredClone(body),
});

let filesBody: unknown = { files: [], truncated: false, cap: 37 };
let filesFailure: { ok: false; status: number; json: () => Promise<unknown> } | null = null;
let filesFetches = 0;
type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
let filesQueue: Array<() => Promise<StubResponse>> = [];
let bundleState: 'active' | 'syncing' | 'failed' = 'active';
let bundleSource: 'zip' | 'git' = 'zip';
let poll: () => void;

function holdFiles() {
  let resolve!: (response: StubResponse) => void;
  let reject!: (error: unknown) => void;
  const response = new Promise<StubResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  filesQueue.push(() => response);
  return { resolve, reject };
}

const listing = (path: string) => ({ files: [{ path, size: 1 }], truncated: false, cap: 37 });
let syncError: string | null = null;

async function fakeFetch(input: unknown) {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname.endsWith('/bundles')) {
    return reply({
      bundles: [
        {
          id: 'b1',
          name: 'docs',
          sourceType: bundleSource,
          status: bundleState,
          lastSyncError: syncError,
          itemCounts: { agent: 1 },
        },
      ],
    });
  }
  if (url.pathname.endsWith('/bundles/b1/files')) {
    filesFetches += 1;
    return filesQueue.length > 0 ? filesQueue.shift()!() : (filesFailure ?? reply(filesBody));
  }
  if (url.pathname.endsWith('/bundles/b1/sync')) {
    bundleState = 'syncing';
    return reply({});
  }
  if (url.pathname.endsWith('/bundles/b1/replace/init')) return reply({ session: { id: 'u1' } });
  if (url.pathname.endsWith('/bundles/b1/replace/u1/complete')) {
    bundleState = 'syncing';
    return reply({});
  }
  if (url.pathname.endsWith('/bundles/uploads/u1/chunk')) return reply({});
  return { ok: false, status: 404, json: async () => ({}) };
}

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  // Drive the composer's interval explicitly; flush() keeps its real setTimeout.
  vi.stubGlobal('setInterval', (callback: () => void) => {
    poll = callback;
    return 1;
  });
  vi.stubGlobal('clearInterval', () => {});
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  updaterReplay.enabled = false;
  bundleState = 'active';
  bundleSource = 'zip';
  filesQueue = [];
  syncError = null;
  filesFailure = null;
  filesFetches = 0;
  filesBody = { files: [{ path: 'a.md', size: 1 }], truncated: true, cap: 37 };
});

it('carries a fetched failed bundle diagnosis into the visible row', async () => {
  bundleState = 'failed';
  syncError = 'Archive import failed. Replace ZIP to retry.';
  let entries: Parameters<typeof BundleComposer>[0]['value'] = [];
  const view = createRenderer(() => (
    <BundleComposer
      initialBundles={[]}
      allowAddZip={false}
      allowAddGit={false}
      credentialOptions={[]}
      repositoryId="r1"
      value={entries}
      onChange={(next) => {
        entries = next;
      }}
    />
  ));
  for (let i = 0; i < 3; i += 1) await view.flush();
  expect(entries[0]).toMatchObject({ status: 'failed', lastSyncError: syncError });
  expect(textOf(view.tree())).toContain(syncError);
});

async function mountExpanded(): Promise<{ view: Renderer; root: () => Host }> {
  const view = createRenderer(() => (
    <BundleComposer
      initialBundles={[]}
      allowAddZip={false}
      allowAddGit={false}
      credentialOptions={[]}
      repositoryId="r1"
      value={[{ id: 'b1', name: 'docs', sourceType: 'zip', status: 'active', itemCount: 1 }]}
      onChange={() => {}}
    />
  ));
  for (let i = 0; i < 3; i += 1) await view.flush();
  const expand = findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).includes('docs'))[0]!;
  fire.click(expand);
  for (let i = 0; i < 3; i += 1) await view.flush();
  return { view, root: view.tree };
}

describe('the bundle file note prints the cap the api answered', () => {
  it('prints the answered cap when the listing is cut', async () => {
    const { root } = await mountExpanded();
    expect(textOf(root())).toContain('Showing first 37 entries — bundle has more files.');
    expect(textOf(root())).not.toContain('5000');
  });

  it('shows no cut note when the listing is complete', async () => {
    filesBody = { files: [{ path: 'a.md', size: 1 }], truncated: false, cap: 37 };
    const { root } = await mountExpanded();
    expect(textOf(root())).not.toContain('Showing first');
  });
});

describe('a refused file listing shows why', () => {
  it("shows the api's own reason, not the status", async () => {
    filesFailure = {
      ok: false,
      status: 409,
      json: async () => ({
        error: 'This bundle is nested too deeply to list its files',
        code: 'bundle_too_deep',
      }),
    };
    const { root } = await mountExpanded();
    expect(textOf(root())).toContain('This bundle is nested too deeply to list its files');
    expect(textOf(root())).not.toContain('files fetch failed');
  });

  it('falls back to the status when the answer names no reason', async () => {
    for (const json of [
      async () => {
        throw new SyntaxError('Unexpected token <');
      },
      async () => null,
      async () => ({ error: 42 }),
      async () => ({ error: '' }),
      async () => ({ error: '   ' }),
    ]) {
      filesFailure = { ok: false, status: 500, json };
      const { root } = await mountExpanded();
      expect(textOf(root())).toContain('files fetch failed (500)');
      expect(textOf(root())).not.toContain('bundle is empty');
    }
  });

  it('asks again on the next expand instead of keeping the failure', async () => {
    filesFailure = { ok: false, status: 500, json: async () => ({ error: 'Try again' }) };
    const { view, root } = await mountExpanded();
    expect(textOf(root())).toContain('Try again');
    filesFailure = null;
    const expand = () =>
      findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).includes('docs'))[0]!;
    fire.click(expand());
    for (let i = 0; i < 3; i += 1) await view.flush();
    fire.click(expand());
    for (let i = 0; i < 3; i += 1) await view.flush();
    expect(textOf(root())).not.toContain('Try again');
    expect(textOf(root())).toContain('a.md');
  });
});

async function settle(view: Renderer) {
  for (let i = 0; i < 3; i += 1) await view.flush();
}

async function mountLive() {
  let entries: Parameters<typeof BundleComposer>[0]['value'] = [];
  const view = createRenderer(() => (
    <BundleComposer
      initialBundles={[]}
      allowAddZip={false}
      allowAddGit={false}
      credentialOptions={[]}
      repositoryId="r1"
      value={entries}
      onChange={(next) => {
        entries = next;
      }}
    />
  ));
  await settle(view);
  return {
    view,
    text: () => textOf(view.tree()),
    click: async (label: string) => {
      fire.click(findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).includes(label))[0]!);
      await settle(view);
    },
    finishSync: async (status: 'active' | 'failed' = 'active') => {
      bundleState = status;
      poll();
      await settle(view);
    },
  };
}

describe('file listings follow the final synced tree', () => {
  beforeEach(() => {
    bundleSource = 'git';
  });

  it('keeps the expanded listing when Resync is accepted', async () => {
    const live = await mountLive();
    await live.click('docs');
    await live.click('Resync');
    expect(live.text()).toContain('syncing');
    expect(live.text()).toContain('a.md');
    expect(filesFetches).toBe(1);
  });

  it.each(['active', 'failed'] as const)(
    'reloads an expanded listing when Resync finishes as %s, showing loading while held',
    async (status) => {
      const live = await mountLive();
      await live.click('docs');
      await live.click('Resync');
      const fresh = holdFiles();
      await live.finishSync(status);
      expect(filesFetches).toBe(2);
      expect(live.text()).toContain('Loading files…');
      expect(live.text()).not.toContain('a.md');
      fresh.resolve(reply(listing('fresh.md')));
      await settle(live.view);
      expect(live.text()).toContain('fresh.md');
      expect(live.text()).not.toContain('Loading files…');
    },
  );

  it('re-asks a listing opened during Resync when syncing finishes', async () => {
    const live = await mountLive();
    await live.click('Resync');
    await live.click('docs');
    expect(live.text()).toContain('a.md');
    filesBody = listing('final.md');
    await live.finishSync();
    expect(filesFetches).toBe(2);
    expect(live.text()).toContain('final.md');
    expect(live.text()).not.toContain('a.md');
  });

  it('re-asks an expanded first-ingest listing when syncing finishes', async () => {
    bundleSource = 'zip';
    bundleState = 'syncing';
    filesBody = listing('partial.md');
    const live = await mountLive();
    await live.click('docs');
    filesBody = listing('complete.md');
    await live.finishSync();
    expect(filesFetches).toBe(2);
    expect(live.text()).toContain('complete.md');
    expect(live.text()).not.toContain('partial.md');
  });

  it('drops a collapsed listing at sync completion and loads only on expand', async () => {
    bundleState = 'syncing';
    const live = await mountLive();
    await live.click('docs');
    await live.click('docs');
    filesBody = listing('final.md');
    await live.finishSync();
    expect(filesFetches).toBe(1);
    await live.click('docs');
    expect(filesFetches).toBe(2);
    expect(live.text()).toContain('final.md');
  });

  it.each(['success', 'failure'] as const)(
    'ignores an old in-flight %s after sync completion and the newer answer',
    async (outcome) => {
      bundleState = 'syncing';
      const live = await mountLive();
      const old = holdFiles();
      await live.click('docs');
      expect(live.text()).toContain('Loading files…');
      filesBody = listing('newer.md');
      await live.finishSync();
      expect(filesFetches).toBe(2);
      expect(live.text()).toContain('newer.md');
      if (outcome === 'success') old.resolve(reply(listing('stale.md')));
      else old.reject(new Error('old failure'));
      await settle(live.view);
      expect(live.text()).toContain('newer.md');
      expect(live.text()).not.toContain('stale.md');
      expect(live.text()).not.toContain('old failure');
    },
  );

  it('keeps an expanded Replace ZIP listing until completion, then reloads it', async () => {
    bundleSource = 'zip';
    const live = await mountLive();
    await live.click('docs');
    const input = findAll(
      live.view.tree(),
      (h) => h.tag === 'input' && h.props.type === 'file',
    )[0]!;
    const onChange = input.props.onChange as (event: {
      target: { files: File[]; value: string };
    }) => void;
    onChange({ target: { files: [new File(['zip'], 'docs.zip')], value: 'docs.zip' } });
    await settle(live.view);
    expect(live.text()).toContain('syncing');
    expect(live.text()).toContain('a.md');
    const fresh = holdFiles();
    await live.finishSync();
    expect(filesFetches).toBe(2);
    expect(live.text()).toContain('Loading files…');
    fresh.resolve(reply(listing('replacement.md')));
    await settle(live.view);
    expect(live.text()).toContain('replacement.md');
  });
});

it.each(['first expand', 'retry'] as const)(
  'starts one file fetch on %s even when state updaters are replayed',
  async (opening) => {
    const live = await mountLive();
    if (opening === 'retry') {
      filesFailure = { ok: false, status: 500, json: async () => ({ error: 'Try again' }) };
      await live.click('docs');
      expect(live.text()).toContain('Try again');
      await live.click('docs');
      filesFailure = null;
    }
    const before = filesFetches;
    updaterReplay.enabled = true;
    await live.click('docs');
    expect(filesFetches).toBe(before + 1);
    expect(live.text()).toContain('a.md');
  },
);
