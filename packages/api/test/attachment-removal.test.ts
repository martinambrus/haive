import { describe, expect, it } from 'vitest';
import { attachmentRemovalPlan, type RemovableAttachment } from '../src/lib/attachment-removal.js';

const row = (id: string, filename: string, expandedFromId: string | null = null) =>
  ({ id, filename, expandedFromId }) satisfies RemovableAttachment;

const plan = (doomed: string[], rows: RemovableAttachment[]) => {
  const out = attachmentRemovalPlan(new Set(doomed), rows);
  return { trees: [...out.trees].sort(), files: [...out.files].sort() };
};

describe('attachmentRemovalPlan', () => {
  it('takes a document’s extracted text with it', () => {
    expect(plan(['a'], [row('a', 'spec.docx'), row('b', 'keep.md')])).toEqual({
      trees: [],
      files: ['spec.docx.extracted.md'],
    });
  });

  it('finds a nested document’s sidecar in its own folder', () => {
    expect(plan(['a'], [row('a', 'docs/spec.pdf')]).files).toEqual(['docs/spec.pdf.extracted.md']);
  });

  it('leaves a file that only shares the sidecar name, when a surviving attachment owns it', () => {
    // Sidecar names are not reserved, so this can be a real upload.
    expect(plan(['a'], [row('a', 'x.docx'), row('b', 'x.docx.extracted.md')]).files).toEqual([]);
  });

  it('removes a deleted archive’s expansion tree whole', () => {
    expect(
      plan(
        ['z'],
        [row('z', 'spec.zip'), row('c1', 'spec/a.md', 'z'), row('c2', 'spec/sub/b.md', 'z')],
      ),
    ).toEqual({ trees: ['spec'], files: ['spec.zip.extracted.md'] });
  });

  it('reaches an expansion tree outside the deleted folder', () => {
    // `docs/x.zip` expands into `x/` at the uploads root, not under `docs/`.
    expect(
      plan(
        ['x', 'd'],
        [
          row('x', 'docs/x.zip'),
          row('c', 'x/a.md', 'x'),
          row('d', 'docs/readme.md'),
          row('y', 'y.zip'),
          row('cy', 'y/b.md', 'y'),
        ],
      ),
    ).toEqual({
      trees: ['x'],
      files: ['docs/readme.md.extracted.md', 'docs/x.zip.extracted.md'],
    });
  });

  it('takes a tree apart member by member when a surviving upload lives in it', () => {
    expect(
      plan(
        ['z'],
        [row('z', 'bundle.zip'), row('c', 'bundle/a.md', 'z'), row('u', 'bundle/mine.md')],
      ),
    ).toEqual({
      trees: [],
      files: ['bundle.zip.extracted.md', 'bundle/a.md', 'bundle/a.md.extracted.md'],
    });
  });

  it('never names the uploads dir itself as a tree', () => {
    const out = attachmentRemovalPlan(new Set(['z']), [row('z', 'a.zip'), row('c', 'odd.md', 'z')]);
    expect(out.trees).toEqual([]);
    expect(out.files).toContain('odd.md');
  });
});
