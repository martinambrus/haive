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

// No DOM in this package: the composer runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));

const reply = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => structuredClone(body),
});

let filesBody: unknown = { files: [], truncated: false, cap: 37 };
let filesFailure: { ok: false; status: number; json: () => Promise<unknown> } | null = null;
let filesFetches = 0;
let bundleState: 'active' | 'failed' = 'active';
let syncError: string | null = null;

async function fakeFetch(input: unknown) {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname.endsWith('/bundles')) {
    return reply({
      bundles: [
        {
          id: 'b1',
          name: 'docs',
          sourceType: 'zip',
          status: bundleState,
          lastSyncError: syncError,
          itemCounts: { agent: 1 },
        },
      ],
    });
  }
  if (url.pathname.endsWith('/bundles/b1/files')) {
    filesFetches += 1;
    return filesFailure ?? reply(filesBody);
  }
  if (url.pathname.endsWith('/bundles/b1/sync')) return reply({});
  return { ok: false, status: 404, json: async () => ({}) };
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  bundleState = 'active';
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

it('a git Resync drops the cached file listing, so the next expand asks again', async () => {
  const view = createRenderer(() => (
    <BundleComposer
      initialBundles={[]}
      allowAddZip={false}
      allowAddGit={false}
      credentialOptions={[]}
      repositoryId="r1"
      value={[{ id: 'b1', name: 'docs', sourceType: 'git', status: 'active', itemCount: 1 }]}
      onChange={() => {}}
    />
  ));
  for (let i = 0; i < 3; i += 1) await view.flush();
  const button = (label: string) =>
    findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).includes(label))[0]!;
  fire.click(button('docs'));
  for (let i = 0; i < 3; i += 1) await view.flush();
  expect(filesFetches).toBe(1);
  fire.click(button('Resync'));
  for (let i = 0; i < 3; i += 1) await view.flush();
  fire.click(button('docs'));
  for (let i = 0; i < 3; i += 1) await view.flush();
  fire.click(button('docs'));
  for (let i = 0; i < 3; i += 1) await view.flush();
  expect(filesFetches).toBe(2);
});
