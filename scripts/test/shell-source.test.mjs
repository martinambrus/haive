import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shellSource, swallowedFailure } from './shell-source.mjs';

const step = 'scanner-control';
const rejects = (script, matched = '|| true') =>
  assert.equal(swallowedFailure(script, { step }), matched);
const url = 'redis://localhost:6379/13';

describe('fail-closed shell lexing (item 1)', () => {
  for (const prefix of [
    'read -r x <<< "$y"',
    'echo $((1 << 2))',
    '((x = 1 << 2))',
    "echo $'it\\'s'",
    'y=${x%% #*}',
    'cat <<E.O.F\ndata\nE.O.F',
    "cat <<E'O'F\ndata\nEOF",
    'echo "$(case "$v" in a) echo ready ;; esac)"',
  ]) {
    it(`sees a swallow after ${JSON.stringify(prefix)}`, () =>
      rejects(`${prefix}\npnpm test || true`));
    it(`sees errexit disabled after ${JSON.stringify(prefix)}`, () =>
      rejects(`${prefix}\nset +e\npnpm test`, 'set +e'));
    it(`sees Redis after ${JSON.stringify(prefix)}`, () =>
      assert.ok(shellSource(`${prefix}\nexport X=${url}`, { step }).includes(url)));
  }
  it('scans backticks inside double quotes', () => rejects('echo "ran `pnpm test || true`"'));
  for (const script of [
    "cat <<'EOF'\ndata",
    'cat <<EOF',
    "echo 'unfinished",
    'echo "unfinished',
    'echo `unfinished',
    'echo "$(echo unfinished"',
  ]) {
    it(`names the step for incomplete syntax ${JSON.stringify(script)}`, () => {
      assert.throws(() => shellSource(script, { step }), /scanner-control: unterminated/);
    });
  }
});

describe('fallback shell separators (item 2)', () => {
  for (const script of [
    '(cmd || true)',
    'x=$(cmd || true)',
    'cmd || true|cat',
    'cmd || true &',
    'cmd || :}',
    'cmd || exit 0)',
  ]) {
    it(`rejects ${script}`, () =>
      rejects(
        script,
        script.includes('exit') ? '|| exit 0' : script.includes(':') ? '|| :' : '|| true',
      ));
  }
});

describe('conditional construct balance (item 3)', () => {
  for (const script of [
    'if a; then x; elif b; then y; fi\npnpm test\ntrue',
    'if a; then x; elif b; then y; elif c; then z; else w; fi\ntrue',
    'if a; then if b; then x; elif c; then y; fi; else z; fi\ntrue',
  ]) {
    it(`rejects a bare success after ${JSON.stringify(script)}`, () => rejects(script, 'true'));
  }
  it('keeps an empty elif branch valid', () =>
    assert.equal(swallowedFailure('if a; then x; elif b; then true; else true; fi'), null));
});

describe('executable heredocs (item 4)', () => {
  for (const command of [
    'bash',
    'sh',
    'ssh host',
    'docker exec -i container sh',
    '/bin/bash',
    'env X=y bash',
  ]) {
    it(`sees a swallow fed to ${command}`, () =>
      rejects(`${command} <<'EOF'\npnpm test || true\nEOF`));
    it(`sees Redis fed to ${command}`, () =>
      assert.ok(shellSource(`${command} <<'EOF'\nexport X=${url}\nEOF`).includes(url)));
  }
  for (const command of ['node', 'python', 'python3 -', 'psql']) {
    it(`sees Redis fed to ${command}`, () =>
      assert.ok(shellSource(`${command} <<'EOF'\nclient("${url}")\nEOF`).includes(url)));
  }
  for (const body of ['$(pnpm test || true)', '`pnpm test || true`']) {
    it(`sees an unquoted substitution ${body}`, () => rejects(`cat <<EOF\n${body}\nEOF`));
    it(`sees Redis in an unquoted substitution ${body}`, () =>
      assert.ok(
        shellSource(`cat <<EOF\n${body.replace('pnpm test || true', `echo ${url}`)}\nEOF`).includes(
          url,
        ),
      ));
  }
  for (const command of ['cat', 'tee file', '>file']) {
    it(`keeps quoted data for ${command} inert`, () => {
      const script = `${command} <<'EOF'\nset +e\n$(cmd || true)\n${url}\nEOF`;
      assert.equal(swallowedFailure(script), null);
      assert.ok(!shellSource(script).includes(url));
    });
  }
  it('keeps an interpreter name in an echo argument inert', () =>
    assert.equal(swallowedFailure("echo bash <<'EOF'\ncmd || true\nEOF"), null));
});

describe('mutation-sensitive lexical branches (item 5)', () => {
  it('keeps a hash inside a word from hiding a later swallow', () =>
    rejects('echo x#tag; cmd || true'));
  it('strips tabs before finding a heredoc terminator and the later swallow', () =>
    rejects("cat <<-'EOF'\n\tset +e\n\tEOF\ncmd || true"));
  for (const prefix of ['then', 'else']) {
    it(`checks errexit after ${prefix}`, () =>
      rejects(
        prefix === 'then'
          ? 'if check; then set +e; fi'
          : 'if check; then echo ready; else set +e; fi',
        'set +e',
      ));
  }
  it('does not confuse an option prefix with set +e', () =>
    assert.equal(swallowedFailure('set +e_not_an_option'), null));
});

describe('remaining failure masks (item 6)', () => {
  for (const [script, matched] of [
    ['cmd || "true"', '|| true'],
    ["cmd || 'true'", '|| true'],
    ['cmd || /bin/true', '|| /bin/true'],
    ['cmd || (exit 0)', '|| (exit 0)'],
    ['cmd; :', ':'],
    ['cmd; :\necho after', ':'],
    ['set +eu', 'set +eu'],
    ['set +o errexit', 'set +o errexit'],
    ['cmd && set +e', 'set +e'],
    ['{ set +e; cmd; }', 'set +e'],
    ['while check; do set +e; done', 'set +e'],
    ['case "$v" in a) set +e ;; esac', 'set +e'],
    ['case "$v" in\na) set +e ;;\nesac', 'set +e'],
    ['cmd && true\necho after', '&& true'],
    ['cmd && true; echo after', '&& true'],
  ]) {
    it(`rejects ${JSON.stringify(script)}`, () => rejects(script, matched));
  }
});
