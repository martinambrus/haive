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

async function fakeFetch(input: unknown) {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname.endsWith('/bundles')) {
    return reply({
      bundles: [
        { id: 'b1', name: 'docs', sourceType: 'zip', status: 'active', itemCounts: { agent: 1 } },
      ],
    });
  }
  if (url.pathname.endsWith('/bundles/b1/files')) return reply(filesBody);
  return { ok: false, status: 404, json: async () => ({}) };
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  filesBody = { files: [{ path: 'a.md', size: 1 }], truncated: true, cap: 37 };
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
