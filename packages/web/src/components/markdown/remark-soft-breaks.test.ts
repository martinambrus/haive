import { describe, expect, it } from 'vitest';
import { remarkSoftBreaks } from './remark-soft-breaks';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const run = (tree: MdNode): MdNode => {
  remarkSoftBreaks()(tree);
  return tree;
};

const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children });
const text = (value: string): MdNode => ({ type: 'text', value });

describe('remarkSoftBreaks', () => {
  it('splits a soft break into a break node', () => {
    const tree = run({ type: 'root', children: [para(text('one\ntwo'))] });
    expect(tree.children![0]!.children).toEqual([
      { type: 'text', value: 'one' },
      { type: 'break' },
      { type: 'text', value: 'two' },
    ]);
  });

  it('handles CRLF and multiple breaks', () => {
    const tree = run({ type: 'root', children: [para(text('a\r\nb\nc'))] });
    expect(tree.children![0]!.children!.map((n) => n.type)).toEqual([
      'text',
      'break',
      'text',
      'break',
      'text',
    ]);
  });

  it('drops the trailing whitespace the newline consumed', () => {
    const tree = run({ type: 'root', children: [para(text('one   \ntwo'))] });
    expect(tree.children![0]!.children![0]).toEqual({ type: 'text', value: 'one' });
  });

  it('leaves a text node without newlines untouched (same array identity)', () => {
    const children = [text('no breaks here')];
    const tree = run({ type: 'root', children: [{ type: 'paragraph', children }] });
    expect(tree.children![0]!.children).toBe(children);
  });

  it('never touches code, inlineCode or html values', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'code', value: 'line1\nline2' },
        para({ type: 'inlineCode', value: 'a\nb' }, { type: 'html', value: '<i>\n</i>' }),
      ],
    });
    expect(tree.children![0]).toEqual({ type: 'code', value: 'line1\nline2' });
    expect(tree.children![1]!.children).toEqual([
      { type: 'inlineCode', value: 'a\nb' },
      { type: 'html', value: '<i>\n</i>' },
    ]);
  });

  it('recurses into nested children and preserves sibling order', () => {
    const tree = run({
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            { type: 'listItem', children: [para(text('kept'))] },
            { type: 'listItem', children: [para(text('split\nhere'))] },
          ],
        },
      ],
    });
    const items = tree.children![0]!.children!;
    expect(items[0]!.children![0]!.children).toEqual([{ type: 'text', value: 'kept' }]);
    expect(items[1]!.children![0]!.children!.map((n) => n.type)).toEqual(['text', 'break', 'text']);
  });

  it('emits consecutive breaks for an empty line without an empty text node', () => {
    const tree = run({ type: 'root', children: [para(text('a\n\nb'))] });
    expect(tree.children![0]!.children!.map((n) => n.type)).toEqual([
      'text',
      'break',
      'break',
      'text',
    ]);
  });
});
