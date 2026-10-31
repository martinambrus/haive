// Test-only lexical pin for this repository's workflow run scripts. Unclassified input throws
// with the step and command. Quoted strings stay visible for Redis URL scans; executable
// substitutions and shell -c strings are scanned as separate code parts.
//
// Limits of any lexical scan, which the pins do not cover: a script written to a file and run
// later (write-then-run); a string whose shell is named dynamically; and shell
// inside a `${{ 'literal shell' }}` expression, which GitHub evaluates before bash sees it.

// Normalise quotes and descriptor redirections before finding command separators.
const plain = (text) =>
  text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '_').replace(/\d*[<>]&\d*-?|&>>?/g, '_');
const lastCommand = (text) => {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  return line.slice(
    Math.max(line.lastIndexOf(';'), line.lastIndexOf('&'), line.lastIndexOf('|')) + 1,
  );
};
const SHELL = /(?:^|[\s/])(?:ba|da|z|k)?sh(?=\s|$)/;
const SHELL_STRING =
  /(?:^|[\s/])(?:ba|da|z|k)?sh(?:\s+(?:[-+]O\s+\S+|[-+]\w*o\s+\S+|[-+]\S+))*\s+-[a-zA-Z]*c$/;
const atCommand = (text) =>
  /^(?:(?:if|then|elif|else|while|until|do)\s+|[({]\s*)*$/.test(lastCommand(text).trimStart());

// GitHub evaluates expressions before the shell sees the script. Preserve line boundaries.
function withoutExpressions(source, step) {
  let result = '';
  for (let i = 0; i < source.length;) {
    if (!source.startsWith('${{', i)) {
      result += source[i++];
      continue;
    }
    const start = i;
    i += 3;
    let quoted = false;
    while (i < source.length) {
      if (source[i] === "'") {
        if (quoted && source[i + 1] === "'") {
          i += 2;
          continue;
        }
        quoted = !quoted;
      }
      if (!quoted && source.startsWith('}}', i)) break;
      i++;
    }
    if (i === source.length) throw new Error(`${step}: unterminated GitHub expression`);
    i += 2;
    result += source.slice(start, i).replace(/[^\n]/g, '_');
  }
  return result;
}

export function shellSource(source, { maskQuotes = false, step = 'shell script' } = {}) {
  source = withoutExpressions(source, step);
  const fail = (what) => {
    throw new Error(`${step}: unterminated ${what}`);
  };
  const unsupported = (command) => {
    throw new Error(`${step}: unsupported command ${JSON.stringify(command.trim())}`);
  };
  const substitutions = [];
  const quoted = (start, quote, ansi = false) => {
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\' && (quote !== "'" || ansi)) {
        i += 2;
        continue;
      }
      if (source[i] === quote) return i + 1;
      if (quote === '"' && source.startsWith('$(', i) && !source.startsWith('$((', i)) {
        const nested = scan(i + 2, ')');
        substitutions.push(nested.text);
        i = nested.end;
      } else if (quote === '"' && source[i] === '`') {
        const end = quoted(i, '`');
        substitutions.push(shellSource(source.slice(i + 1, end - 1), { maskQuotes, step }));
        i = end;
      } else i++;
    }
    fail('quote');
  };
  const arithmetic = (start) => {
    let depth = 2;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '(') depth++;
      if (source[i] === ')' && --depth === 0) return i + 1;
    }
    fail('arithmetic expression');
  };
  // A shell word with its quotes removed: adjacent quoted and unquoted parts form one value, as for
  // a heredoc delimiter or the command string of bash -c.
  const shellWord = (start) => {
    let i = start;
    let value = '';
    let quotedWord = false;
    while (i < source.length && !/[\s;|&()<>]/.test(source[i])) {
      if (source.startsWith("$'", i)) {
        const end = quoted(i + 1, "'", true);
        value += source.slice(i + 2, end - 1);
        quotedWord = true;
        i = end;
      } else if (source[i] === "'" || source[i] === '"') {
        const end = quoted(i, source[i]);
        const inner = source.slice(i + 1, end - 1);
        value += source[i] === '"' ? inner.replace(/\\([$`"\\])/g, '$1') : inner;
        quotedWord = true;
        i = end;
      } else if (source[i] === '\\') {
        quotedWord = true;
        if (i + 1 >= source.length) fail('heredoc delimiter');
        value += source[i + 1];
        i += 2;
      } else value += source[i++];
    }
    return { value, quotedWord, end: i };
  };
  const scan = (start, stop = null, parameter = false) => {
    let result = '';
    let i = start;
    const heredocs = [];
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        if (source[i + 1] !== '\n') result += maskQuotes ? '__' : source.slice(i, i + 2);
        i += 2;
      } else if (char === "'" || char === '"' || char === '`' || source.startsWith("$'", i)) {
        const ansi = source.startsWith("$'", i);
        const quoteStart = i + Number(ansi);
        const end = quoted(quoteStart, source[quoteStart], ansi);
        if (char === '`')
          substitutions.push(shellSource(source.slice(i + 1, end - 1), { maskQuotes, step }));
        const literal = source.slice(quoteStart + 1, end - 1);
        const commandName = literal === 'true' && /(?:\|\||&&)\s*$/.test(result);
        const header = lastCommand(result).trim();
        if (/\bsu\s+.*-c$/.test(header)) unsupported(header);
        if (maskQuotes && char !== '`' && SHELL_STRING.test(header)) {
          const word = shellWord(i);
          substitutions.push(shellSource(word.value, { maskQuotes, step }));
          result += '_'.repeat(word.end - i);
          i = word.end;
          continue;
        }
        result += maskQuotes ? (commandName ? literal : '_'.repeat(end - i)) : source.slice(i, end);
        i = end;
      } else if (source.startsWith('$((', i) || (!parameter && source.startsWith('((', i))) {
        const end = arithmetic(i + (char === '$' ? 3 : 2));
        result += source.slice(i, end);
        i = end;
      } else if (source.startsWith('${', i)) {
        const nested = scan(i + 2, '}', true);
        result += '${' + nested.text + '}';
        i = nested.end;
      } else if (source.startsWith('$(', i) || (!parameter && char === '(')) {
        const size = char === '$' ? 2 : 1;
        const nested = scan(i + size, ')');
        result += source.slice(i, i + size) + nested.text + ')';
        i = nested.end;
      } else if (!parameter && char === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]))) {
        while (i < source.length && source[i] !== '\n') i++;
      } else if (source.startsWith('<<<', i)) {
        if (SHELL.test(lastCommand(result))) unsupported(lastCommand(result).trim() + ' <<<');
        result += '<<<';
        i += 3;
      } else if (!parameter && source.startsWith('<<', i)) {
        const tabs = source[i + 2] === '-';
        let wordStart = i + 2 + Number(tabs);
        while (/[ \t]/.test(source[wordStart] ?? '')) wordStart++;
        const word = shellWord(wordStart);
        if (word.end === wordStart) fail('heredoc delimiter');
        const eol = source.indexOf('\n', word.end);
        const line = source.slice(word.end, eol === -1 ? undefined : eol);
        const command = lastCommand(plain(source.slice(start, i)))
          .trim()
          .split(/\s+/)[0];
        const reject = (reason) => {
          throw new Error(
            `${step}: heredoc ${JSON.stringify(word.value)} command ${JSON.stringify(command)}: ${reason}`,
          );
        };
        if (!word.quotedWord) reject('unquoted delimiter');
        if (plain(line).split('#')[0].includes('|')) reject('pipe after operator');
        const consumer = /^(?:cat|tee|read|done)$/.test(command)
          ? 'data'
          : /^(?:python3|node|psql)$/.test(command)
            ? 'interpreter'
            : /^(?:bash|sh|dash|ksh|zsh)$/.test(command)
              ? 'code'
              : null;
        if (!consumer) reject('unclassified consumer');
        heredocs.push({ delimiter: word.value, tabs, consumer });
        result += maskQuotes ? '<<_' : source.slice(i, word.end);
        i = word.end;
      } else if (char === '\n') {
        result += source[i++];
        for (const { delimiter, tabs, consumer } of heredocs.splice(0)) {
          let body = '';
          let terminated = false;
          while (i < source.length) {
            const end = source.indexOf('\n', i);
            const next = end === -1 ? source.length : end;
            const line = source.slice(i, next);
            i = end === -1 ? source.length : end + 1;
            if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
              terminated = true;
              break;
            }
            body += (tabs ? line.replace(/^\t+/, '') : line) + '\n';
          }
          if (!terminated) fail(`heredoc ${JSON.stringify(delimiter)}`);
          if (consumer === 'code') {
            const code = shellSource(body, { maskQuotes, step });
            if (maskQuotes) substitutions.push(code);
            else result += '\n' + code + '\n';
          }
          if (consumer === 'interpreter' && !maskQuotes) result += '\n' + body + '\n';
        }
      } else if (!parameter && char === '|' && source[i - 1] !== '|' && source[i + 1] !== '|') {
        const next = source
          .slice(i + 1)
          .trimStart()
          .split(/[;&|\n]/, 1)[0];
        if (SHELL.test(plain(next))) unsupported('| ' + next);
        result += char;
        i++;
      } else if (char === stop) {
        if (heredocs.length) fail('heredoc');
        return { text: result, end: i + 1 };
      } else if (
        !parameter &&
        /[a-zA-Z_]/.test(char) &&
        (i === 0 || /[\s;|&()]/.test(source[i - 1]))
      ) {
        const rest = source.slice(i);
        const word = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(rest)[0];
        if (/^(?:eval|ssh)$/.test(word) && atCommand(result)) unsupported(rest.split('\n')[0]);
        result += word;
        i += word.length;
      } else {
        result += char;
        i++;
      }
    }
    if (heredocs.length) fail('heredoc');
    if (stop) fail(stop === '}' ? 'parameter expansion' : 'command substitution');
    return { text: result, end: i };
  };
  const result = scan(0).text;
  // Code that runs apart from the script (substitutions, strings given to a shell) follows it as
  // parts of its own, so that what ends a script is judged for each part.
  return result + (maskQuotes ? substitutions.map((code) => '\0' + code).join('') : '');
}

export function swallowedFailure(source, options = {}) {
  for (const script of shellSource(source, { ...options, maskQuotes: true }).split('\0')) {
    const matched = swallowedBy(script);
    if (matched) return matched;
  }
  return null;
}

function swallowedBy(script) {
  const fallback =
    /\|\|\s*(?:(?:\/(?:usr\/)?bin\/)?true(?=[\s;|&)}]|$)|:(?=[\s;|&)}]|$)|exit\s+0(?=[\s;|&)}]|$)|\(\s*exit\s+0\s*\)(?=[\s;|&)}]|$))/.exec(
      script,
    );
  if (fallback) return fallback[0].replace(/\s+/g, ' ').trim();
  const colon = /;\s*:(?=[ \t]*(?:\n|$))/.exec(script);
  if (colon) return ':';
  const continued = /&&\s*true(?=[\s;|&)}]|$)(?=[ \t]*(?:;|\n)[\s\S]*\S)/.exec(script);
  if (continued) return continued[0].replace(/\s+/g, ' ').trim();
  let branches = 0;
  let loops = 0;
  let functions = 0;
  for (let command of script.replace(/&&\s*true\s*$/, '&& _').split(/&&|\|\||[;\n]/)) {
    command = command.trim().replace(/^[({]\s*/, '');
    if (/^(?:while|until|for|select)\b/.test(command)) loops++;
    if (/^done\b/.test(command)) loops = Math.max(0, loops - 1);
    if (/^(?:\w+\s*\(\)|function\s+\w+(?:\s*\(\))?)\s*(?:\{|$)/.test(command)) functions++;
    if (/^}/.test(command)) functions = Math.max(0, functions - 1);
    if (/^(?:fi|esac)\b/.test(command)) branches = Math.max(0, branches - 1);
    if (/^(?:if|case)\b/.test(command)) branches++;
    // The keyword or case pattern that opens a body is not the command in it.
    command = command.replace(/^(?:then|else|do)\b\s*/, '');
    if (branches) command = command.replace(/^(?:case\b.*?\bin\s+)?[^)]*\)\s*/, '');
    const disabled =
      /^set\s+(?:\+(?=[abefhkmnptuvxBCEHPT]*e)[abefhkmnptuvxBCEHPT]+(?=\s|$)|\+o\s+errexit(?=\s|$))/.exec(
        command,
      );
    if (disabled) return disabled[0];
    // A bare true is the conventional empty body of a construct; anywhere else it hides a failure.
    if (branches === 0 && loops === 0 && functions === 0 && /^true(?=\s|[)}]|$)/.test(command))
      return 'true';
  }
  return null;
}
