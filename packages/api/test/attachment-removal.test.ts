import { describe, expect, it } from 'vitest';
import { filesToRemove, type RemovableAttachment } from '../src/lib/attachment-removal.js';

const row = (id: string, filename: string, expandedFromId: string | null = null) =>
  ({ id, filename, expandedFromId }) satisfies RemovableAttachment;

const files = (doomed: string[], rows: RemovableAttachment[]) =>
  [...filesToRemove(new Set(doomed), rows)].sort();

describe('filesToRemove', () => {
  it('takes a document’s extracted text with it', () => {
    expect(files(['a'], [row('a', 'spec.docx'), row('b', 'keep.md')])).toEqual([
      'spec.docx',
      'spec.docx.extracted.md',
    ]);
  });

  it('finds a nested document’s sidecar in its own folder', () => {
    expect(files(['a'], [row('a', 'docs/spec.pdf')])).toEqual([
      'docs/spec.pdf',
      'docs/spec.pdf.extracted.md',
    ]);
  });

  it('leaves a file that only shares the sidecar name, when a surviving attachment owns it', () => {
    // Sidecar names are not reserved, so this can be a real upload.
    expect(files(['a'], [row('a', 'x.docx'), row('b', 'x.docx.extracted.md')])).toEqual(['x.docx']);
  });

  it('takes a deleted archive’s members one file at a time, never its folder', () => {
    expect(
      files(
        ['z'],
        [row('z', 'spec.zip'), row('c1', 'spec/a.md', 'z'), row('c2', 'spec/sub/b.md', 'z')],
      ),
    ).toEqual([
      'spec.zip',
      'spec.zip.extracted.md',
      'spec/a.md',
      'spec/a.md.extracted.md',
      'spec/sub/b.md',
      'spec/sub/b.md.extracted.md',
    ]);
  });

  it('reaches the members of an archive inside the deleted folder, which sit at the root', () => {
    // `docs/x.zip` expands into `x/` at the uploads root, not under `docs/`.
    expect(
      files(
        ['x', 'd'],
        [
          row('x', 'docs/x.zip'),
          row('c', 'x/a.md', 'x'),
          row('d', 'docs/readme.md'),
          row('y', 'y.zip'),
          row('cy', 'y/b.md', 'y'),
        ],
      ),
    ).toEqual([
      'docs/readme.md',
      'docs/readme.md.extracted.md',
      'docs/x.zip',
      'docs/x.zip.extracted.md',
      'x/a.md',
      'x/a.md.extracted.md',
    ]);
  });

  it('leaves an upload that lives in a deleted archive’s folder', () => {
    // A folder upload whose top level matches the expansion directory lands inside it.
    expect(
      files(
        ['z'],
        [row('z', 'bundle.zip'), row('c', 'bundle/a.md', 'z'), row('u', 'bundle/mine.md')],
      ),
    ).toEqual(['bundle.zip', 'bundle.zip.extracted.md', 'bundle/a.md', 'bundle/a.md.extracted.md']);
  });

  it('takes a member deleted on its own, and nothing of its archive', () => {
    expect(files(['c'], [row('z', 'spec.zip'), row('c', 'spec/a.md', 'z')])).toEqual([
      'spec/a.md',
      'spec/a.md.extracted.md',
    ]);
  });

  it('lists a file once when a deleted attachment has another’s sidecar name', () => {
    const out = filesToRemove(new Set(['a', 'b']), [
      row('a', 'x.docx'),
      row('b', 'x.docx.extracted.md'),
    ]);
    expect(out.filter((f) => f === 'x.docx.extracted.md')).toHaveLength(1);
    expect([...out].sort()).toEqual([
      'x.docx',
      'x.docx.extracted.md',
      'x.docx.extracted.md.extracted.md',
    ]);
  });
});
