import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { shellSource, swallowedFailure } from './shell-source.mjs';

const step = 'scanner-control';
const rejects = (script, matched = '|| true') =>
  assert.equal(swallowedFailure(script, { step }), matched);
const url = 'redis://localhost:6379/13';
// bash -n is the oracle for a script the scanner must not throw on.
const bashAccepts = (script) => {
  const { status, stderr } = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(status, 0, `bash rejects the control: ${stderr}`);
};

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

describe('heredoc bodies by consumer', () => {
  for (const command of [
    'bash',
    'sh',
    'ssh host',
    'docker exec -i container sh',
    '/bin/bash',
    'env X=y bash',
    'sudo bash',
    'sudo -E bash',
    'sudo -u x sh',
    'time bash',
    'timeout 60 bash',
    'nohup sh',
    'env -i bash',
    '/usr/bin/env bash',
    'exec bash',
    'command bash',
    'FOO="a b" bash',
    'source /dev/stdin',
    '. /dev/stdin',
    'docker compose exec -T svc sh',
    'docker run -i img sh',
    'kubectl exec -i p -- sh',
    'xargs -I{} sh',
    '$SHELL',
    'mycmd',
  ]) {
    it(`sees a swallow fed to ${command}`, () => {
      const script = `${command} <<'EOF'\npnpm test || true\nEOF`;
      bashAccepts(script);
      rejects(script);
    });
    it(`sees Redis fed to ${command}`, () =>
      assert.ok(shellSource(`${command} <<'EOF'\nexport X=${url}\nEOF`).includes(url)));
  }
  for (const [prefix, suffix] of [
    ['if true; then ', '\nfi'],
    ['for x in a; do ', '\ndone'],
    ['! ', ''],
    ['{ ', '\n}'],
    ['(', '\n)'],
  ]) {
    it(`sees a swallow fed to bash after ${JSON.stringify(prefix)}`, () => {
      const script = `${prefix}bash <<'EOF'\npnpm test || true\nEOF${suffix}`;
      bashAccepts(script);
      rejects(script);
    });
  }
  for (const script of [
    "<<'EOF' bash\npnpm test || true\nEOF",
    "<<'EOF' bash -s\npnpm test || true\nEOF",
    "cat <<'EOF' | bash\npnpm test || true\nEOF",
    "cat <<'EOF' | sh -e\npnpm test || true\nEOF",
    "cat <<'EOF' | sudo bash\npnpm test || true\nEOF",
    "cat <<'EOF' | tee out | bash\npnpm test || true\nEOF",
    "cat <<'EOF' | tr a b\npnpm test || true\nEOF",
    "cat <<'EOF' |\npnpm test || true\nEOF\nbash",
  ]) {
    it(`sees a swallow in ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      rejects(script);
    });
  }
  for (const script of [
    'eval "$(cat <<\'EOF\'\npnpm test || true\nEOF\n)"',
    "eval $(cat <<'EOF'\npnpm test || true\nEOF\n)",
    "source <(cat <<'EOF'\npnpm test || true\nEOF\n)",
    'bash -c "$(cat <<\'EOF\'\npnpm test || true\nEOF\n)"',
    "bash < <(cat <<'EOF'\npnpm test || true\nEOF\n)",
  ]) {
    it(`sees a swallow in ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      rejects(script);
    });
  }
  it('keeps a body inert when a substitution only echoes it', () => {
    const script = 'echo "$(cat <<\'EOF\'\npnpm test || true\nEOF\n)"';
    bashAccepts(script);
    assert.equal(swallowedFailure(script), null);
  });
  for (const command of [
    'node',
    'python',
    'python3 -',
    'psql',
    'docker exec -i c node -',
    'sudo node',
    'tsx -',
    'deno run -',
    'bun -',
  ]) {
    it(`sees Redis fed to ${command}`, () =>
      assert.ok(shellSource(`${command} <<'EOF'\nclient("${url}")\nEOF`).includes(url)));
    it(`keeps a swallow fed to ${command} inert`, () =>
      assert.equal(swallowedFailure(`${command} <<'EOF'\nx || true\nEOF`), null));
  }
  it('sees Redis fed to an interpreter through a pipe', () => {
    const script = `cat <<'EOF' | node -\nclient("${url}")\nEOF`;
    assert.ok(shellSource(script).includes(url));
    assert.equal(swallowedFailure(script), null);
  });
  for (const body of ['$(pnpm test || true)', '`pnpm test || true`']) {
    it(`sees an unquoted substitution ${body}`, () => rejects(`cat <<EOF\n${body}\nEOF`));
    it(`sees Redis in an unquoted substitution ${body}`, () =>
      assert.ok(
        shellSource(`cat <<EOF\n${body.replace('pnpm test || true', `echo ${url}`)}\nEOF`).includes(
          url,
        ),
      ));
  }
  for (const command of [
    'cat',
    'tee file',
    '>file',
    'read -r a',
    'mapfile -t a',
    'sed s/a/b/',
    'awk 1',
    'grep x',
    'jq .',
    'while read -r a; do :; done',
  ]) {
    it(`keeps quoted data for ${command} inert`, () => {
      const script = `${command} <<'EOF'\nset +e\n$(cmd || true)\n${url}\nEOF`;
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
      assert.ok(!shellSource(script).includes(url));
    });
  }
  it('keeps quoted data piped to another data sink inert', () => {
    const script = `cat <<'EOF' | grep x\nset +e\n$(cmd || true)\n${url}\nEOF`;
    bashAccepts(script);
    assert.equal(swallowedFailure(script), null);
    assert.ok(!shellSource(script).includes(url));
  });
  it('keeps quoted data inert for a bare redirection', () =>
    assert.equal(swallowedFailure("<<'EOF'\nset +e\nEOF"), null));
  it('keeps a shell name in the arguments of a data command inert', () =>
    assert.equal(swallowedFailure("grep bash <<'EOF'\ncmd || true\nEOF"), null));
  it('throws with the step name when an unrecognised command reads a body that is not shell', () => {
    const script = "mycmd <<'EOF'\nIt's data\nEOF";
    bashAccepts(script);
    assert.throws(() => shellSource(script, { step }), /scanner-control: unterminated quote/);
  });
});

describe('unquoted heredoc bodies: only the expansions are code', () => {
  for (const expansion of [
    '$(pnpm test || true)',
    '`pnpm test || true`',
    '${x:-$(pnpm test || true)}',
    '$(( $(pnpm test || true) + 1 ))',
  ]) {
    for (const lead of ['### Report ', '# ', 'Total: ']) {
      it(`runs ${expansion} after ${JSON.stringify(lead)}`, () =>
        rejects(`cat <<EOF\n${lead}${expansion}\nEOF`));
    }
  }
  for (const prose of ['if', 'for', 'while', 'until', 'select', 'case', 'f() {', 'function f']) {
    it(`keeps the bare true rule after a prose line starting with ${JSON.stringify(prose)}`, () =>
      rejects(`cat <<EOF\n${prose} $(date)\ntrue\nEOF\npnpm test\ntrue`, 'true'));
  }
  for (const prose of [
    "It's",
    'say "hi',
    'Rows (approx:',
    '100% ) of',
    "Run took $(( SECONDS / 60 )) min - it's fine,",
  ]) {
    it(`does not lex the prose ${JSON.stringify(prose)} beside an expansion`, () => {
      const script = `cat >> "$GITHUB_STEP_SUMMARY" <<EOF\n${prose} $(date)\nEOF\npnpm test || true`;
      bashAccepts(script);
      rejects(script);
    });
  }
  it('keeps a swallow written as prose beside an expansion inert', () =>
    assert.equal(swallowedFailure('cat <<EOF\nretry with cmd || true: $(date)\nEOF'), null));
  it('keeps an escaped expansion inert', () =>
    assert.equal(
      swallowedFailure('cat <<EOF\n\\$(pnpm test || true) \\`pnpm test || true\\`\nEOF'),
      null,
    ));
  it('reads the Redis URL of an expansion but not of the prose', () => {
    const text = shellSource(`cat <<EOF\nuse redis://localhost:6379/7 $(echo ${url})\nEOF`, {
      step,
    });
    assert.ok(text.includes(url));
    assert.ok(!text.includes('/7'));
  });
  it('reads an interpreter body for Redis beside an expansion and an apostrophe', () =>
    assert.ok(
      shellSource(`node <<EOF\nclient("${url}") // it's $(date)\nEOF`, { step }).includes(url),
    ));
  it('runs an expansion on a comment line of a script heredoc', () =>
    rejects('bash <<EOF\n# $(pnpm test || true)\nEOF'));
  it('keeps the same comment line inert when the delimiter is quoted', () =>
    assert.equal(swallowedFailure("bash <<'EOF'\n# $(pnpm test || true)\nEOF"), null));
});

describe('syntax bash accepts that the lexer must not throw on', () => {
  for (const script of [
    'y=${x%%(*}',
    'y=${x//(/_}',
    'y=${x#*(}',
    'y=${x//((/_}',
    'x=$(echo case; for y in a; do :; done)',
    'n=$(grep -rw case src | grep -c in)',
    'echo "$(echo case; for y in a; do :; done)"',
    'echo $[1<<2]',
    'echo $[ $(echo 1) << 2 ]',
    'echo ${x:-$[1<<2]}',
  ]) {
    it(`reads ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      rejects(`${script}; pnpm test || true`);
      rejects(`${script}\nset +e`, 'set +e');
      assert.ok(shellSource(`${script}\nexport X=${url}`, { step }).includes(url));
    });
  }
  for (const word of [
    '"$v"',
    '$v',
    '"${v%%.*}"',
    '${v%%.*}',
    '"$(uname -s)"',
    '$(uname -s)',
    "'lit'",
    '"a b"',
  ]) {
    it(`still reads the case statement on ${word} inside a substitution`, () => {
      const script = `echo "$(case ${word} in a) pnpm test || true ;; esac)"`;
      bashAccepts(script);
      rejects(script);
    });
  }
  for (const word of ['"${a:-"b c"}"', '"$(printf %s "$x")"', '$(echo $(uname))']) {
    it(`reads the case statement on ${word} at a command position`, () => {
      const script = `echo "$(case ${word} in a) pnpm test || true ;; esac)"`;
      bashAccepts(script);
      rejects(script);
    });
  }
  it('reads a case statement that starts an arm of another one', () => {
    const script = 'echo "$(case $a in x) case $b in y) pnpm test || true ;; esac ;; esac)"';
    bashAccepts(script);
    rejects(script);
  });
  it('does not take a variable named case for a case statement', () => {
    const script = 'x=$(case=1; for y in a; do :; done); pnpm test || true';
    bashAccepts(script);
    rejects(script);
  });
});

describe('strings that a shell runs as code', () => {
  for (const script of [
    'bash -c "x || true"',
    "sh -c 'x || true'",
    "bash -ec 'x || true'",
    "bash -o pipefail -c 'x || true'",
    "sudo bash -c 'x || true'",
    "eval 'x || true'",
    'eval "x || true"',
    "ssh host 'x || true'",
    "su -c 'x || true'",
    "docker exec c sh -c 'x || true'",
    "docker compose -f a.yml exec -T w sh -c 'x || true'",
    "printf '%s\\n' a | xargs -I{} sh -c 'x || true'",
    'bash <<< "x || true"',
    "echo 'x || true' | sh",
    "printf '%s\\n' 'x || true' | sudo bash",
    "echo 'x || true' |\n  sh",
    "echo 'x || true' | bash -s",
  ]) {
    it(`sees a swallow in ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      rejects(script);
    });
  }
  it('sees errexit disabled in a string', () => rejects("bash -c 'set +e; pnpm test'", 'set +e'));
  it('sees a bare true in a string', () => rejects("sh -c 'pnpm test; true'", 'true'));
  for (const script of [
    'echo "x || true"',
    "printf '%s' 'set +e'",
    'bash script.sh "x || true"',
    'node -e "a || true"',
    'python3 -c "a or True"',
    'cat <<< "x || true"',
    "read -r v <<< 'x || true'",
    "echo 'x || true' | cat",
    "echo 'x || true' | grep x",
    'git commit -m "fix || true"',
    "echo 'x || true'; echo hi | sh",
    "echo 'x || true' || sh",
    'bash -c "echo \\"a || true \\""',
  ]) {
    it(`keeps the string of ${JSON.stringify(script)} inert`, () => {
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
    });
  }
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

describe('shell control data and empty bodies (item 7)', () => {
  for (const script of [
    'echo ${{ inputs.flag || true }}',
    "echo ${{ format('}}', inputs.flag || true) }}",
    'case "$v" in\na)\ntrue\n;;\nesac',
    'while check; do\ntrue\ndone',
    'for x in a b; do\ntrue\ndone',
    'f() {\ntrue\n}',
    'function f {\ntrue\n}',
  ]) {
    it(`accepts ${JSON.stringify(script)}`, () => assert.equal(swallowedFailure(script), null));
  }
  for (const prefix of [
    'echo ${{ inputs.flag || true }}',
    'case "$v" in a) true ;; esac',
    'while check; do true; done',
    'f() { true; }',
  ]) {
    it(`still checks code after ${JSON.stringify(prefix)}`, () =>
      rejects(`${prefix}\ntrue`, 'true'));
  }
  it('rejects an errexit window even when it is closed later', () =>
    rejects('set +e\ncmd\nstatus=$?\nset -e', 'set +e'));
});
