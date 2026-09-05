import { describe, it, expect } from 'vitest';
import { renderAttachmentsManifest } from './manifest.js';

describe('renderAttachmentsManifest', () => {
  it('returns null when there is nothing to index', () => {
    expect(renderAttachmentsManifest([])).toBeNull();
  });

  it('renders a flat list unchanged from the pre-folder shape', () => {
    expect(
      renderAttachmentsManifest([
        { filename: 'brief.md', description: 'the brief' },
        { filename: 'wireframe.png', description: null },
      ]),
    ).toBe(
      [
        '# Attached files',
        '',
        'User-attached reference files for this task. Read any you need.',
        '',
        '- `brief.md` — the brief',
        '- `wireframe.png`',
        '',
      ].join('\n'),
    );
  });

  it('groups by directory and writes every path in full', () => {
    const out = renderAttachmentsManifest([
      { filename: 'docs/api/schema.json', description: null },
      { filename: 'brief.md', description: null },
      { filename: 'docs/spec.md', description: 'API spec' },
    ]);
    expect(out).toBe(
      [
        '# Attached files',
        '',
        'User-attached reference files for this task. Read any you need.',
        '',
        '- `brief.md`',
        '',
        '## `docs/`',
        '',
        '- `docs/spec.md` — API spec',
        '',
        '## `docs/api/`',
        '',
        '- `docs/api/schema.json`',
        '',
      ].join('\n'),
    );
  });
});
