/** `content` as one fenced code block, the fence longer than any backtick run inside it:
 *  the content's own ``` would otherwise end the block and render the rest as markdown. */
export function fencedCode(content: string, lang = ''): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}
