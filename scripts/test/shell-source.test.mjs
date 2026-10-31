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
