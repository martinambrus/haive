import type { CommitDiffFile, CommitDiffStatus } from '@haive/shared/commit-diff-artifact';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommitDiffViewer } from './commit-diff-viewer';
import { createRenderer, findAll, fire, textOf, type Renderer } from '../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));

let files: CommitDiffFile[] = [];

async function fakeFetch() {
  return {
    ok: true,
    status: 200,
    json: async () =>
      structuredClone({ headSha: 'abc', fileCount: files.length, truncated: false, files }),
  };
}

const noop = () => {};

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('window', {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  });
});
afterAll(() => vi.unstubAllGlobals());

const file = (
  path: string,
  status: CommitDiffStatus,
  extra: Partial<CommitDiffFile> = {},
): CommitDiffFile => ({
  path,
  status,
  binary: false,
  truncated: false,
  oldContent: '',
  newContent: '',
  ...extra,
});

async function mount(list: CommitDiffFile[]): Promise<Renderer> {
  files = list;
  const view = createRenderer(() => <CommitDiffViewer taskId="t1" artifactPath="diff.json" />);
  for (let i = 0; i < 3; i += 1) await view.flush();
  return view;
}

const MESSAGE = 'Could not read this file';

describe('the diff viewer shows an unreadable file as unreadable', () => {
  it('modified: no empty-side diff, no counters', async () => {
    const text = textOf((await mount([file('a.txt', 'modified', { unreadable: true })])).tree());
    expect(text).toContain(MESSAGE);
    expect(text).toContain('unreadable');
    for (const absent of ['No content changes', 'Empty file', '+0', '-0']) {
      expect(text).not.toContain(absent);
    }
  });

  it('deleted: not "Empty file deleted."', async () => {
    const text = textOf((await mount([file('a.txt', 'deleted', { unreadable: true })])).tree());
    expect(text).toContain(MESSAGE);
    expect(text).not.toContain('Empty file deleted.');
  });

  it('added: not "Empty file added."', async () => {
    const text = textOf((await mount([file('a.txt', 'added', { unreadable: true })])).tree());
    expect(text).toContain(MESSAGE);
    expect(text).not.toContain('Empty file added.');
  });

  it('a readable file still renders its diff', async () => {
    const view = await mount([
      file('a.txt', 'modified', { oldContent: 'one\ntwo\n', newContent: 'one\nthree\n' }),
    ]);
    const text = textOf(view.tree());
    expect(text).toContain('+1');
    expect(text).toContain('-1');
    expect(text).toContain('three');
    expect(text).not.toContain('Could not read');
  });

  it('a file without the field and empty contents reads as before', async () => {
    const text = textOf((await mount([file('a.txt', 'modified')])).tree());
    expect(text).toContain('No content changes.');
    expect(text).not.toContain('Could not read');
  });

  it('switching files swaps the message and the diff', async () => {
    const view = await mount([
      file('bad.txt', 'modified', { unreadable: true }),
      file('good.txt', 'modified', { oldContent: 'one\ntwo\n', newContent: 'one\nthree\n' }),
    ]);
    const click = async (path: string) => {
      fire.click(findAll(view.tree(), (h) => h.tag === 'button' && h.props.title === path)[0]!);
      for (let i = 0; i < 3; i += 1) await view.flush();
    };
    expect(textOf(view.tree())).toContain(MESSAGE);
    await click('good.txt');
    expect(textOf(view.tree())).not.toContain(MESSAGE);
    expect(textOf(view.tree())).toContain('three');
    await click('bad.txt');
    expect(textOf(view.tree())).toContain(MESSAGE);
  });
});
