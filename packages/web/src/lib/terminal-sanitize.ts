// Sanitizers applied to raw byte streams before they are written to xterm.

// xterm's VT500 parser defines no GROUND-state transition for 0x7f (DEL): a bare
// DEL byte drives the parser into its ERROR action, which xterm logs as
// "xterm.js: Parsing error:" — the Next dev overlay then surfaces that console.error
// as a page error. CLIs and shells emit stray DEL when they dump binary-ish content
// (DEL is a valid single-byte UTF-8 code, so the worker's utf8 StringDecoder passes
// it through while truly-invalid bytes become U+FFFD). DEL is a no-op control in a
// real terminal (ECMA-48) and is the only byte a UTF-8 codepoint stream can hit that
// GROUND leaves undefined, so dropping it before write is the complete fix. Removing
// DEL is parser-state-neutral (every defined DEL cell keeps the same state), so it
// can never shift a following sequence. Display-only — any persisted log keeps the
// original bytes.
export function stripDel(s: string): string {
  return s.includes('\x7f') ? s.replaceAll('\x7f', '') : s;
}
