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

describe('code stays visible after constructs the lexer skips whole', () => {
  for (const [prefix, joins] of [
    ['read -r x <<< "$y"', ['\n', '; ']],
    ['echo $((1 << 2))', ['\n', '; ']],
    ['((x = 1 << 2))', ['\n', '; ']],
    ["echo $'it\\'s'", ['\n', '; ']],
    ['y=${x%% #*}', ['\n', '; ']],
    ["cat <<'E.O.F'\ndata\nE.O.F", ['\n']],
    ["cat <<E'O'F\ndata\nEOF", ['\n']],
  ]) {
    for (const join of joins) {
      const head = JSON.stringify(prefix + join);
      it(`sees a swallow after ${head}`, () => rejects(`${prefix}${join}pnpm test || true`));
      it(`sees errexit disabled after ${head}`, () =>
        rejects(`${prefix}${join}set +e\npnpm test`, 'set +e'));
      it(`sees Redis after ${head}`, () =>
        assert.ok(shellSource(`${prefix}${join}export X=${url}`, { step }).includes(url)));
    }
  }
  it('scans backticks inside double quotes', () => rejects('echo "ran `pnpm test || true`"'));
});

describe('unterminated syntax throws with the step name', () => {
  for (const [script, what] of [
    ["cat <<'EOF'\ndata", 'heredoc "EOF"'],
    ["cat <<'EOF'", 'heredoc'],
    ["echo $(cat <<'EOF')", 'heredoc'],
    ["echo 'unfinished", 'quote'],
    ['echo "unfinished', 'quote'],
    ['echo `unfinished', 'quote'],
    ['echo "$(echo unfinished"', 'quote'],
    ['echo $(echo unfinished', 'command substitution'],
    ['echo ${x:-unfinished', 'parameter expansion'],
    ['echo $((1 + 2', 'arithmetic expression'],
  ]) {
    it(`names the step for ${JSON.stringify(script)}`, () => {
      assert.throws(
        () => shellSource(script, { step }),
        new RegExp(`^Error: scanner-control: unterminated ${what.replace(/"/g, '\\"')}$`),
      );
    });
  }
});

describe('fallback success followed by a separator', () => {
  for (const [form, matched] of [
    ['true', '|| true'],
    [':', '|| :'],
    ['exit 0', '|| exit 0'],
    ['(exit 0)', '|| (exit 0)'],
  ]) {
    for (const separator of [';', '&', '|', ')', '}', ' &']) {
      it(`rejects ${JSON.stringify(`cmd || ${form}${separator}`)}`, () =>
        rejects(`cmd || ${form}${separator}`, matched));
    }
  }
  for (const script of [
    '(cmd || true)',
    'x=$(cmd || true)',
    'cmd || true;echo',
    'cmd || true&echo',
  ]) {
    it(`rejects ${script}`, () => rejects(script));
  }
});

describe('if, elif, else and fi balance for the bare true rule', () => {
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

describe('quoted heredocs classified by their command word', () => {
  for (const command of ['cat', 'tee file', 'read -r a', 'while read -r a; do :; done']) {
    it(`keeps quoted data for ${command} inert`, () => {
      const script = `${command} <<'EOF'\nit's data\nset +e\n$(cmd || true)\n${url}\nEOF`;
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
      assert.ok(!shellSource(script).includes(url));
    });
  }
  for (const command of ['bash', 'sh', 'dash', 'ksh', 'zsh']) {
    it(`reads the quoted code of ${command}`, () => {
      rejects(`${command} <<'EOF'\npnpm test || true\nEOF`);
      rejects(`${command} <<'EOF'\npnpm test\ntrue\nEOF`, 'true');
      assert.ok(shellSource(`${command} <<'EOF'\nexport X=${url}\nEOF`).includes(url));
    });
  }
  for (const command of ['node', 'python3 -', 'psql']) {
    it(`reads ${command} only for Redis URLs`, () => {
      const script = `${command} <<'EOF'\nclient("${url}") // it's data\nx || true\nEOF`;
      assert.ok(shellSource(script).includes(url));
      assert.equal(swallowedFailure(script), null);
    });
  }
  for (const [operator, indent] of [
    ["<< 'EOF'", ''],
    ["<<- 'EOF'", '\t'],
    ['<<"EOF"', ''],
    ['<<\\EOF', ''],
  ]) {
    it(`reads the quoted delimiter ${operator}`, () => {
      const script = `bash ${operator}\n${indent}pnpm test || true\n${indent}EOF`;
      bashAccepts(script);
      rejects(script);
    });
  }
  it('keeps a quoted comment in shell code inert', () =>
    assert.equal(swallowedFailure("bash <<'EOF'\n# $(pnpm test || true)\nEOF"), null));
  it('keeps a body inert when a substitution only echoes it', () =>
    assert.equal(swallowedFailure('echo "$(cat <<\'EOF\'\npnpm test || true\nEOF\n)"'), null));
});

describe('heredoc headers normalise redirections and quoted separators', () => {
  for (const header of ['>&2', '2>&1', "'a|b'", "'a;b'", '"a&b"']) {
    for (const position of ['before', 'after']) {
      it(`keeps ${header} ${position} the operator out of the command split`, () => {
        const line = position === 'before' ? `cat ${header} <<'EOF'` : `cat <<'EOF' ${header}`;
        const script = `${line}\nit's data; set +e; cmd || true\n${url}\nEOF`;
        bashAccepts(script);
        assert.equal(swallowedFailure(script), null);
        assert.ok(!shellSource(script).includes(url));
      });
    }
  }
});

describe('unclassified inputs throw their named diagnostic', () => {
  for (const [script, message] of [
    ['cat <<EOF\nx || true\nEOF', 'heredoc "EOF" command "cat": unquoted delimiter'],
    ["sudo bash <<'EOF'\nx || true\nEOF", 'heredoc "EOF" command "sudo": unclassified consumer'],
    ["mysql <<'EOF'\nit's data\nEOF", 'heredoc "EOF" command "mysql": unclassified consumer'],
    ["cat <<'EOF' | grep x\ndata\nEOF", 'heredoc "EOF" command "cat": pipe after operator'],
    ["cat <<'EOF' |\ndata\nEOF\nbash", 'heredoc "EOF" command "cat": pipe after operator'],
    ["eval 'x || true'", 'unsupported command "eval \'x || true\'"'],
    ["ssh host 'x || true'", 'unsupported command "ssh host \'x || true\'"'],
    ["su -c 'x || true'", 'unsupported command "su -c"'],
    ["echo 'x || true' | sh", 'unsupported command "| sh"'],
    ["bash <<< 'x || true'", 'unsupported command "bash <<<"'],
    [
      'echo "$(case $v in a) cmd || true ;; esac)"',
      'unsupported command "case $v in a) cmd || true ;; esac)\\""',
    ],
    ["time eval 'x || true'", 'unsupported command "time eval \'x || true\'"'],
    [
      "source <(cat <<'EOF'\npnpm test || true\nEOF\n)",
      'unsupported command "source <(cat <<\'EOF\'"',
    ],
    [". <(echo 'x || true')", 'unsupported command ". <(echo \'x || true\')"'],
  ]) {
    it(`throws ${message}`, () => {
      bashAccepts(script);
      for (const maskQuotes of [false, true])
        assert.throws(() => shellSource(script, { step, maskQuotes }), {
          message: `${step}: ${message}`,
        });
    });
  }
});

describe('parameter patterns and case words among arguments stay ordinary words', () => {
  for (const script of [
    'y=${x%%(*}',
    'y=${x//(/_}',
    'y=${x#*(}',
    'y=${x//((/_}',
    'x=$(echo case; for y in a; do :; done)',
    'n=$(grep -rw case src | grep -c in)',
    'n=$(echo case x in y)',
    'n=$(grep -w case x in)',
    'x=$(echo case "a b" in y)',
    'case=1',
    'x=$(case=1; echo ok)',
  ]) {
    it(`reads ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      rejects(`${script}; pnpm test || true`);
      rejects(`${script}\nset +e`, 'set +e');
      assert.ok(shellSource(`${script}\nexport X=${url}`, { step }).includes(url));
    });
  }
});

describe('quoted strings after a shell word with -c are separate code parts', () => {
  for (const command of [
    'bash -c',
    'sh -c',
    'dash -c',
    'zsh -c',
    'ksh -c',
    'bash -ec',
    'bash -o pipefail -c',
    'sudo bash -c',
    'docker exec c sh -c',
    'docker run --rm img sh -c',
    'kubectl exec p -- sh -c',
    'env -u X bash -c',
    '/bin/sh -c',
  ]) {
    it(`sees a swallow in ${command}`, () => rejects(`${command} 'x || true'`));
  }
  for (const script of [
    "bash -c 'echo '\"'\"'a'\"'\"'; pnpm test || true'",
    "bash -c $'x || true'",
  ])
    it(`reads the whole word of ${JSON.stringify(script)}`, () => rejects(script));
  for (const script of [
    "bash -c 'echo it\\'\"'\"'s'",
    "bash -c 'echo $1' _ \"it's\"",
    "sh -c 'x' _ 'y || true'",
  ])
    it(`reads one script word in ${JSON.stringify(script)}`, () =>
      assert.equal(swallowedFailure(script), null));
  it('sees errexit disabled in a string', () => rejects("bash -c 'set +e; pnpm test'", 'set +e'));
  it('sees a bare true in a string', () => rejects("sh -c 'pnpm test; true'", 'true'));
  for (const script of [
    'echo "x || true"',
    "printf '%s' 'set +e'",
    'bash script.sh "x || true"',
    'node -e "a || true"',
    'python3 -c "a or True"',
    'psql -c "SELECT 1 || true"',
    "grep -c 'a || true' f",
    'cat <<< "x || true"',
    "read -r v <<< 'x || true'",
    "echo 'x || true' | cat",
    "echo 'x || true' | grep x",
    'git commit -m "fix || true"',
    "echo 'x || true' || sh",
    'bash -c "echo \\"a || true \\""',
  ])
    it(`keeps ${JSON.stringify(script)} inert`, () => {
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
    });
});

describe('a trailing && true after code that is scanned as a separate part', () => {
  for (const script of [
    "sh -c 'echo hi' && true",
    'bash -c "echo hi" && echo x && true',
    'echo "$(date)" && true',
    'echo `date` && true',
    'x="$(cmd && true)"',
    'x="$(cmd && true)" && true',
  ]) {
    it(`accepts ${JSON.stringify(script)}`, () => {
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
    });
  }
  for (const script of [
    "sh -c 'echo hi' && true\necho after",
    'echo "$(date)" && true; echo after',
  ]) {
    it(`rejects ${JSON.stringify(script)}`, () => rejects(script, '&& true'));
  }
  it('keeps a bare true in the body of a construct when a heredoc body holds a substitution', () =>
    assert.equal(
      swallowedFailure("if x; then\n  bash <<'EOF'\necho `date`\nEOF\n  true\nfi"),
      null,
    ));
});

describe('comments, tabs and prefixes of the lexer', () => {
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

describe('quoted, parenthesised and prefixed failure masks', () => {
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
  for (const script of [
    'set +x',
    'set +u',
    'set +xu',
    'set +o pipefail',
    'set +o errexitx',
    'set -e',
    'set -euo pipefail',
  ]) {
    it(`accepts ${JSON.stringify(script)}, which leaves errexit on`, () =>
      assert.equal(swallowedFailure(script), null));
  }
});

describe('expressions and empty construct bodies', () => {
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

// Distinguishing controls for the single-branch mutation pass.
describe('lexical boundaries that change a verdict or URL scan', () => {
  for (const prefix of ['echo a & ', 'echo a | '])
    it(`finds the heredoc command after ${prefix}`, () => {
      const script = `${prefix}cat <<'EOF'\nit's data\nEOF`;
      bashAccepts(script);
      assert.equal(swallowedFailure(script), null);
    });
  for (const script of ["echo a | cat 'do sh -c'", 'cmd; :foo', "echo . 'x || true'"])
    it(`keeps ${JSON.stringify(script)} inert`, () => assert.equal(swallowedFailure(script), null));
  for (const script of [
    '`cmd || true`',
    'set \\\n+e',
    'echo $(( ((1)) << 2 )); cmd || true',
    "bash -c $'true'",
  ])
    it(`sees the code in ${JSON.stringify(script)}`, () =>
      rejects(
        script,
        script.startsWith('set') ? 'set +e' : script.endsWith("'true'") ? 'true' : '|| true',
      ));
  for (const [script, what] of [
    ['echo ${{ unfinished', 'GitHub expression'],
    ['cat <<', 'heredoc delimiter'],
    ['cat <<\\', 'heredoc delimiter'],
  ])
    it(`names unterminated ${what} for ${JSON.stringify(script)}`, () =>
      assert.throws(() => shellSource(script, { step }), {
        message: `${step}: unterminated ${what}`,
      }));
  it('does not open a case for an assignment before a bare success', () =>
    rejects('case=1; pnpm test; true', 'true'));
  it('preserves expression line boundaries', () =>
    assert.equal(shellSource('echo ${{\na\n}}\ntrue').split('\n').length, 4));
  it('keeps escaped GitHub quotes from exposing a literal fallback', () =>
    assert.equal(swallowedFailure("echo ${{ format('it''s }} || true', inputs.x) }}"), null));
  it('does not treat backticks after -c as a literal script string', () =>
    assert.equal(swallowedFailure('bash -c `echo hi`'), null));
  it('keeps shell strings visible to the Redis URL scan', () =>
    assert.ok(shellSource(`bash -c 'echo ${url}'`).includes(url)));
  it('keeps heredoc operators inside parameter patterns inert', () =>
    rejects('echo ${x:-<<EOF}; cmd || true'));
  it('ignores a pipe in a heredoc header comment', () =>
    assert.equal(swallowedFailure("cat <<'EOF' # | sh\nit's data\nEOF"), null));
  it('judges a shell heredoc independently of an outer conditional', () =>
    rejects("if check; then\nbash <<'EOF'\npnpm test\ntrue\nEOF\nfi", 'true'));
  it('rejects a shell on the line after a pipe', () =>
    assert.throws(() => swallowedFailure("echo 'x || true' |\n sh", { step }), {
      message: `${step}: unsupported command "| sh"`,
    }));
  it('does not append masked code parts to the URL scan', () =>
    assert.equal(shellSource('echo "$(echo hi)"'), 'echo "$(echo hi)"'));
});
