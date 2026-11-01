import { expect, it, vi } from 'vitest';
import { FilesystemBrowser } from './filesystem-browser';
import { createRenderer, findAll, fire, textOf } from '../../test/render-tree';
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
const name = 'a-directory-name-that-is-much-too-long-for-a-phone'.repeat(4);
vi.mock('@/lib/api-client', () => ({
  api: {
    get: async () => ({
      path: '/repos',
      parent: null,
      entries: [{ name, path: `/repos/${name}`, isDirectory: true, hasGit: true, hidden: false }],
    }),
  },
}));
it('lets a long directory name shrink while keeping its full title and Pick action', async () => {
  const onSelect = vi.fn();
  const view = createRenderer(() => <FilesystemBrowser initialPath="/repos" onSelect={onSelect} />);
  await view.flush();
  const dir = findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).includes(name))[0]!;
  expect(String(dir.props.className).split(' ')).toContain('min-w-0');
  expect(dir.props.title).toBe(name);
  expect(findAll(dir, (h) => h.tag === 'span' && textOf(h) === name)[0]?.props.className).toContain(
    'truncate',
  );
  fire.click(findAll(view.tree(), (h) => h.tag === 'button' && textOf(h) === 'Pick')[0]!);
  expect(onSelect).toHaveBeenCalledWith(`/repos/${name}`, true);
});
