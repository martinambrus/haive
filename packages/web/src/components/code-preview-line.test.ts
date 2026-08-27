import { describe, expect, it } from 'vitest';
import { findSymbolLine } from './code-preview-source';

describe('findSymbolLine', () => {
  it('has no line to point at without a symbol', () => {
    expect(findSymbolLine('a\nb\n', null)).toBeNull();
  });

  it('prefers the declaration over an earlier mention', () => {
    // The first whole-word hit for a PHP function is usually its doc comment.
    const php = ['<?php', '/*', ' * Function: smtpmail', ' */', 'function smtpmail($to) {'].join(
      '\n',
    );
    expect(findSymbolLine(php, 'smtpmail')).toBe(5);
  });

  it('falls back to the first mention when nothing declares it', () => {
    expect(findSymbolLine(['x', 'call smtpmail();', 'y'].join('\n'), 'smtpmail')).toBe(2);
  });

  it('takes the last segment of a qualified symbol', () => {
    const src = ['class Mailer {', '  function SendMail() {}', '}'].join('\n');
    expect(findSymbolLine(src, 'Mailer::SendMail')).toBe(2);
  });

  it('matches whole words only', () => {
    // `sendMailLater` is a different function; pointing at it would be a lie.
    expect(findSymbolLine('function sendMailLater() {}', 'sendMail')).toBeNull();
  });

  it('returns null when the symbol is not in this checkout', () => {
    expect(findSymbolLine('nothing here\n', 'smtpmail')).toBeNull();
  });

  it('does not treat a symbol as a regular expression', () => {
    expect(findSymbolLine('const a_b = 1;', 'a.b')).toBeNull();
  });
});
