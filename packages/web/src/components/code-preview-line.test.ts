import { describe, expect, it } from 'vitest';
import { findSymbolLine, symbolCandidates } from './code-preview-source';

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

  it('reads a breadcrumb-style symbol field, not just a bare identifier', () => {
    // Agents write this field both ways; both are real data in the dev plan.
    const php = [
      '<?php',
      'session_start();',
      'require init.php;',
      'function generateErrorPage($t) {}',
    ].join('\n');
    expect(findSymbolLine(php, 'generateErrorPage / installer gate / require init.php')).toBe(4);
  });

  it('prefers a declaration of ANY candidate over a mention of the first', () => {
    const src = ['call installer();', 'function generateErrorPage() {}'].join('\n');
    expect(findSymbolLine(src, 'installer gate / generateErrorPage')).toBe(2);
  });

  it('falls back to a mention when nothing in the phrase is declared', () => {
    const src = ['boot();', 'installer_gate();'].join('\n');
    expect(findSymbolLine(src, 'installer_gate / whatever')).toBe(2);
  });

  it('treats define() as a declaration', () => {
    const src = ["require 'x';", "define('RS_ALIAS_REDIRECT', 1);"].join('\n');
    expect(findSymbolLine(src, 'RS_ALIAS_REDIRECT define / require index.php')).toBe(2);
  });

  it('drops candidates too short to mean anything', () => {
    expect(symbolCandidates('a / of / generateErrorPage')).toEqual(['generateErrorPage']);
  });

  it('does not treat a symbol as a regular expression', () => {
    expect(findSymbolLine('const a_b = 1;', 'a.b')).toBeNull();
  });
});
