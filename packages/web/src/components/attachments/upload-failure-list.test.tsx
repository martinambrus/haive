import { describe, expect, it, vi } from 'vitest';
import { UploadFailureList } from './upload-failure-list';
import { createRenderer, findAll, textOf } from '../../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));

describe('UploadFailureList', () => {
  it('states how many of the picked files failed, then names each with its message', () => {
    const view = createRenderer(() => (
      <UploadFailureList
        total={3}
        failed={[
          { name: 'a.md', message: 'too large' },
          { name: 'c.md', message: 'type not allowed' },
        ]}
      />
    ));
    expect(textOf(view.tree())).toContain('2 of 3 attachment(s) could not be uploaded:');
    const list = findAll(view.tree(), (h) => h.tag === 'ul')[0]!;
    expect(list.props['aria-label']).toBe('Attachments that failed to upload');
    expect(list.props.className).toBe(
      'max-h-48 list-disc overflow-auto pl-5 [overflow-wrap:anywhere]',
    );
    expect(findAll(list, (h) => h.tag === 'li').map((li) => textOf(li))).toEqual([
      'a.md: too large',
      'c.md: type not allowed',
    ]);
  });
});
