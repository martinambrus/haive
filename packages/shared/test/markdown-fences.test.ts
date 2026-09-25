import { describe, expect, it } from 'vitest';
import { fencedLines, scanFences } from '../src/markdown-fences.js';

const scan = (text: string) => scanFences(text.split('\n'));

describe('scanFences', () => {
  it('reads a fence and the first word of its info string', () => {
    expect(scan('```ts title="a b"\nconst x = 1;\n```')).toEqual([
      { lang: 'ts', open: 0, close: 2, content: ['const x = 1;'] },
    ]);
  });

  it('closes a fence only on a run of its own character at least as long', () => {
    const fences = scan('````md\n```before\nold\n```\n~~~\n````');
    expect(fences).toEqual([
      { lang: 'md', open: 0, close: 5, content: ['```before', 'old', '```', '~~~'] },
    ]);
    expect(scan('~~~\n```\n~~~~')).toEqual([{ lang: '', open: 0, close: 2, content: ['```'] }]);
  });

  it('does not close on a fence line that carries an info string', () => {
    expect(scan('```\n```js\n```')[0]).toMatchObject({ close: 2, content: ['```js'] });
  });

  it('takes up to three spaces of indentation, and removes it from the content', () => {
    expect(scan('   ```\n     x\n  y\n   ```')).toEqual([
      { lang: '', open: 0, close: 3, content: ['  x', 'y'] },
    ]);
    expect(scan('    ```\n    x\n    ```')).toEqual([]);
  });

  it('refuses a backtick fence whose info string holds a backtick, but not a tilde one', () => {
    expect(scan('``` a`b\nx\n```')).toEqual([{ lang: '', open: 2, close: null, content: [] }]);
    expect(scan('~~~ a`b\nx\n~~~')).toEqual([{ lang: 'a`b', open: 0, close: 2, content: ['x'] }]);
  });

  it('runs an unclosed fence to the end of the text', () => {
    expect(scan('text\n```py\na\nb')).toEqual([
      { lang: 'py', open: 1, close: null, content: ['a', 'b'] },
    ]);
  });

  it('reads CRLF lines', () => {
    expect(scan('```js\r\nx\r\n```\r')).toEqual([
      { lang: 'js', open: 0, close: 2, content: ['x\r'] },
    ]);
  });
});

describe('fencedLines', () => {
  it('marks every fence line and the lines inside, to the end for an unclosed fence', () => {
    expect(fencedLines('a\n```\nb\n```\nc\n~~~\nd'.split('\n'))).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});
