export const PROMPT_STEP_OUTPUT_CAP_BYTES = 16 * 1024;
export function capStepOutput(text: string, cap: number = PROMPT_STEP_OUTPUT_CAP_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= cap) return text;
  const notice = (shown: number): string =>
    `\n[truncated: ${bytes.length - shown} more bytes not shown]`;
  // notice(0) holds the most digits any notice can, so the head always leaves room for its own.
  const room = Math.max(cap - Buffer.byteLength(notice(0)), 0);
  const head = bytes.subarray(0, room).toString('utf8').replace(/�+$/, '');
  return head + notice(Buffer.byteLength(head));
}
