import { describe, it, expect } from 'vitest';
import {
  extractMarkdownSections,
  extractCodeSections,
  chunkSection,
  capChunks,
  contextHeader,
  MAX_CHUNKS_PER_FILE,
} from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

/** Body of roughly `size` chars carrying a unique MARK<n> token every ~100 chars,
 *  so a test can assert that every region of the source survived into some chunk
 *  — the direct check for "nothing was silently truncated". */
function markedBody(size: number, prefix = 'MARK'): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < size; i += 1) {
    const line = `${prefix}${i} ` + 'x'.repeat(90) + '\n';
    parts.push(line);
    len += line.length;
  }
  return parts.join('');
}

function marksIn(text: string, prefix = 'MARK'): Set<string> {
  return new Set(text.match(new RegExp(`${prefix}\\d+`, 'g')) ?? []);
}

describe('extractMarkdownSections', () => {
  it('carries H1 > H2 > H3 ancestry as a breadcrumb', () => {
    const md = [
      '# Deployment',
      'intro text',
      '## DDEV',
      'ddev text',
      '### Ports',
      'port text',
      '## Docker',
      'docker text',
    ].join('\n');

    const byId = new Map(extractMarkdownSections(md, 'doc.md').map((s) => [s.sectionId, s]));

    expect(byId.get('ports')?.breadcrumb).toEqual(['Deployment', 'DDEV', 'Ports']);
    // A sibling H2 must clear the deeper level rather than inherit 'Ports'.
    expect(byId.get('docker')?.breadcrumb).toEqual(['Deployment', 'Docker']);
    expect(byId.get('deployment')?.breadcrumb).toEqual(['Deployment']);
  });
});

describe('extractCodeSections — full coverage', () => {
  it('keeps a long function whole instead of cutting it at 3000 chars', () => {
    const php = `<?php\nfunction big_one() {\n${markedBody(10_000)}\n}\n`;
    const all = extractCodeSections(php, 'mod.php')
      .map((s) => s.content)
      .join('\n');

    expect(marksIn(all)).toEqual(marksIn(php));
  });

  it('indexes the regions between matches instead of dropping them', () => {
    const php = `<?php\n${markedBody(400, 'TOP')}\nfunction only_one() {\n  return 1;\n}\n${markedBody(20_000, 'TAIL')}\n`;
    const sections = extractCodeSections(php, 'legacy.module');
    const all = sections.map((s) => s.content).join('\n');

    expect(marksIn(all, 'TOP')).toEqual(marksIn(php, 'TOP'));
    expect(marksIn(all, 'TAIL')).toEqual(marksIn(php, 'TAIL'));
    expect(sections.some((s) => s.sectionId === 'function-only_one')).toBe(true);
  });

  it('covers a file whose regexes match nothing (legacy jQuery style)', () => {
    const js = `jQuery(document).ready(function ($) {\n${markedBody(15_000)}\n});\n`;
    const sections = extractCodeSections(js, 'legacy.js');

    expect(sections.length).toBeGreaterThan(0);
    expect(marksIn(sections.map((s) => s.content).join('\n'))).toEqual(marksIn(js));
  });

  it('never emits a section id containing ":" (the stale-key separator)', () => {
    const php = `<?php\nclass Foo {\n  public function bar() {\n    return 1;\n  }\n}\n`;
    for (const s of extractCodeSections(php, 'Foo.php')) {
      expect(s.sectionId).not.toContain(':');
    }
  });

  it('names a PHP method after its enclosing class', () => {
    const php = `<?php\nclass Foo {\n  public function bar() {\n    return 1;\n  }\n}\n`;
    const method = extractCodeSections(php, 'Foo.php').find((s) =>
      s.content.includes('function bar'),
    );

    expect(method?.sectionId).toBe('method-Foo-bar');
    expect(method?.breadcrumb).toEqual(['class Foo', 'function bar']);
  });
});

describe('chunkSection', () => {
  it('splits a long section without losing any region', () => {
    const content = markedBody(10_000);
    const chunks = chunkSection({ sectionId: 's', content, breadcrumb: [] });

    expect(chunks.length).toBeGreaterThan(4);
    expect(marksIn(chunks.map((c) => c.content).join('\n'))).toEqual(marksIn(content));
    // Chunk indexes are dense and ordered — they are half of the row identity.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('prepends the header to EVERY chunk and folds it into the hash', () => {
    const content = markedBody(6000);
    const plain = chunkSection({ sectionId: 's', content, breadcrumb: [] });
    const withHeader = chunkSection(
      { sectionId: 's', content, breadcrumb: ['class Foo'] },
      { header: contextHeader('src/Foo.php', ['class Foo']) },
    );

    expect(withHeader.length).toBe(plain.length);
    for (const c of withHeader) {
      expect(c.content.startsWith('[src/Foo.php > class Foo]')).toBe(true);
    }
    // A changed header must force a re-embed, so the hash cannot ignore it.
    expect(withHeader[0]!.chunkHash).not.toBe(plain[0]!.chunkHash);
  });

  it('is byte-identical to the header-less form when no header is given', () => {
    const section = { sectionId: 's', content: markedBody(6000), breadcrumb: [] };
    expect(chunkSection(section, {})).toEqual(chunkSection(section));
  });
});

describe('contextHeader', () => {
  it('joins the root with the breadcrumb', () => {
    expect(contextHeader('src/Foo.php', ['class Foo', 'function bar'])).toBe(
      'src/Foo.php > class Foo > function bar',
    );
  });

  it('collapses a repeat of the root (a KB entry whose H1 is its title)', () => {
    expect(contextHeader('ext/mysql Quick Reference', ['ext/mysql Quick Reference', 'Usage'])).toBe(
      'ext/mysql Quick Reference > Usage',
    );
  });
});

describe('capChunks', () => {
  it('keeps the budget and reports what it dropped', () => {
    const chunks = chunkSection({
      sectionId: 's',
      content: markedBody(2000 * (MAX_CHUNKS_PER_FILE + 40)),
      breadcrumb: [],
    });
    expect(chunks.length).toBeGreaterThan(MAX_CHUNKS_PER_FILE);

    const capped = capChunks(chunks);
    expect(capped.chunks.length).toBe(MAX_CHUNKS_PER_FILE);
    expect(capped.dropped).toBe(chunks.length - MAX_CHUNKS_PER_FILE);
  });

  it('reports nothing dropped when under budget', () => {
    const chunks = chunkSection({ sectionId: 's', content: 'short', breadcrumb: [] });
    expect(capChunks(chunks)).toEqual({ chunks, dropped: 0 });
  });
});
