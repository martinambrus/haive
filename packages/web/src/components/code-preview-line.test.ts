import { describe, expect, it } from 'vitest';
import {
  evidenceLine,
  findSymbolLine,
  resolvePreviewLine,
  symbolCandidates,
} from './code-preview-source';

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

describe('locating a symbol written as a line of code', () => {
  // The real failure: a link whose symbol was a whole PHP statement pointed at
  // a comment 546 lines away that merely contained the word "new".
  const php = [
    '<?php',
    '// due to the fact that somebody might have already inserted new record',
    'function boot() {}',
    "$fck = new FCKeditor('FCKeditor1');",
    "$fck->Width = '99%';",
  ].join('\n');

  it('matches the statement as written, not a word inside it', () => {
    expect(findSymbolLine(php, "$fck = new FCKeditor('FCKeditor1')")).toBe(4);
  });

  it('tolerates different spacing around the same statement', () => {
    expect(findSymbolLine(php, "$fck   =  new   FCKeditor('FCKeditor1')")).toBe(4);
  });

  it('never picks a language keyword as the location', () => {
    // "new" appears on line 2 first; it names a language, not a place.
    expect(findSymbolLine(php, 'new')).toBeNull();
  });

  it('matches a sigil-prefixed variable, which a word boundary cannot', () => {
    expect(findSymbolLine(php, '$fck')).toBe(4);
  });

  it('prefers code over a comment that says the same word', () => {
    const src = ['// smtpmail is described here', 'function smtpmail() {}'].join('\n');
    expect(findSymbolLine(src, 'smtpmail')).toBe(2);
  });

  it('falls back to a comment when the symbol appears nowhere else', () => {
    const src = ['// only mentioned in prose: smtpmail', 'echo 1;'].join('\n');
    expect(findSymbolLine(src, 'smtpmail')).toBe(1);
  });
});

describe('evidenceLine', () => {
  it('takes the line the agent stated outright', () => {
    expect(evidenceLine('line 596 — the single construction site', 700)).toBe(596);
    expect(evidenceLine('lines 28-88 carry the guards', 700)).toBe(28);
  });

  it('ignores a line number the file cannot have', () => {
    expect(evidenceLine('line 9000', 700)).toBeNull();
    expect(evidenceLine('line 0', 700)).toBeNull();
  });

  it('has nothing to say when evidence names no line', () => {
    expect(evidenceLine('the only transport below Mail::Send', 700)).toBeNull();
    expect(evidenceLine(null, 700)).toBeNull();
    expect(evidenceLine(undefined, 700)).toBeNull();
  });
});

describe('resolvePreviewLine', () => {
  // The banner case, from a real link: evidence said "lines 172-515: tree menu
  // init, ..." and 172 is the HTML comment that introduces that region.
  const markupPage = [
    '<?php', // 1
    'require_once("index.php");', // 2
    '', // 3
    '<!-- TREE MENU AND ELEMENT MANAGEMENT FUNCTIONS - START ====== //-->', // 4
    '<div id="treeDiv1"></div>', // 5
    'function insertElement(type) {}', // 6
  ].join('\n');

  it('steps off the banner onto the code it introduces', () => {
    expect(resolvePreviewLine(markupPage, 'insertElement', 'lines 4-6: tree menu init')).toBe(5);
  });

  it('leaves a stated line alone when it is already code', () => {
    expect(resolvePreviewLine(markupPage, 'insertElement', 'line 2 bootstraps')).toBe(2);
  });

  it('does not mistake an HTML banner for the symbol it names', () => {
    // Without <!-- in the comment set, "TREE" would match the banner first.
    expect(findSymbolLine(markupPage, 'treeDiv1')).toBe(5);
  });

  it('keeps a comment when only more comments follow it', () => {
    // A file header describing the file IS the best answer available; walking
    // 12 lines out of it would land on an unrelated first statement.
    const header = ['<?php', '/*', ' * Description: language file', ' *', ' *', ' *'].join('\n');
    expect(resolvePreviewLine(header, 'language file', null)).toBe(3);
  });

  it('has no line when neither evidence nor symbol finds one', () => {
    expect(resolvePreviewLine(markupPage, 'nowhereAtAll', 'no line here')).toBeNull();
  });
});
