// Conservative lexical filter for workflow safety pins. Uncertain syntax fails closed: it is read
// as code, or the scan throws with the step name. Quoted strings are kept for URL scans, and
// executable substitutions are exposed for command scans.
//
// Limits of any lexical scan, which the pins do not cover: a script written to a file and run
// later (write-then-run); a heredoc or string whose consumer is not its command word, once the
// wrappers below are stripped (a variable, a function, a launcher that is not listed); and shell
// inside a `${{ 'literal shell' }}` expression, which GitHub evaluates before bash sees it.

// Prefixes that only run the command after them: reserved words, function and case heads,
// redirections, assignments, paths and the wrappers sudo, env, timeout, xargs and docker exec.
const WRAPPERS = [
  /^(?:\(|\{(?=\s))\s*/,
  /^(?:function\s+\w+(?:\s*\(\))?|\w+\s*\(\))\s*\{\s*/,
  /^case\s+\S+\s+in\s+/,
  /^\(?[^\s()|]+(?:\|[^\s()|]+)*\)\s*/,
  /^(?:if|then|elif|else|while|until|do|time|nohup|command|exec|builtin|!)\s+/,
  /^\d*[<>]+&?\s*[^\s<>]+\s*/,
  /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+/,
  /^\/(?:[^\s/]+\/)*/,
  /^env(?:\s+(?:-\S+|[A-Za-z_]\w*=\S*))*\s+/,
  /^sudo(?:\s+(?:-[ughpCDrtTU]\s+\S+|-\S*))*\s+/,
  /^timeout(?:\s+(?:-[ks]\s+\S+|-\S+))*\s+[\d.]+[smhd]?\s+/,
  /^xargs(?:\s+(?:-[ILnPdsEa]\s*\S+|-\S+))*\s+/,
  /^docker(?:-compose|\s+compose)?(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+exec(?:\s+(?:-[euw]\s+\S+|--(?:env|user|workdir)\s+\S+|-\S+))*\s+\S+\s+/,
];

// The text after the last separator: the simple command being read. A newline is a separator, so
// only the last line is searched: a search over the whole text made long scripts quadratic.
const lastCommand = (text) => {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  return line.slice(
    Math.max(line.lastIndexOf(';'), line.lastIndexOf('&'), line.lastIndexOf('|')) + 1,
  );
};

// The command word and its arguments, once the wrappers are stripped.
function commandOf(text) {
  let command = text.trim();
  for (let before = ''; before !== command;) {
    before = command;
    for (const wrapper of WRAPPERS) command = command.replace(wrapper, '');
  }
  return command;
}

// What a command does with its input: a shell runs it, an interpreter reads it, a data sink
// only stores or filters it. Everything else is unknown.
function kindOf(command) {
  if (/^(?:bash|sh|dash|ksh|zsh|ssh|su|eval|source|\.)(?=\s|$)/.test(command)) return 'shell';
  if (/^(?:node|python[\d.]*|psql|ruby|perl|php|tsx|deno|bun)(?=\s|$)/.test(command))
    return 'interpreter';
  if (/^(?:(?:cat|tee|read|mapfile|sed|awk|grep|jq|done)(?=\s|$)|$)/.test(command)) return 'data';
  return 'other';
}

// Whether the next word starts a command.
const atCommand = (text) => commandOf(lastCommand(text) + ' _') === '_';

// Whether the command being read runs its input as code.
const readsCode = (text) => kindOf(commandOf(lastCommand(text))) === 'shell';

// Whether a command reads the script it runs from its standard input: a shell that is given no -c
// string and no script file, or is told to read standard input with -s.
function readsScript(command) {
  const [shell, ...args] = command.replace(/\s[-+]\w*[oO]\s+\S+/g, '').split(/\s+/);
  return (
    /^(?:bash|sh|dash|ksh|zsh)$/.test(shell) &&
    !args.some((arg) => /^-\w*c/.test(arg)) &&
    (args.every((arg) => arg.startsWith('-')) || args.some((arg) => /^-\w*s/.test(arg)))
  );
}

// Whether the command being read runs the string it is given as code: the string after bash -c
// or su -c, any string after eval or ssh, or a herestring fed to a shell that reads its script.
function readsStrings(text) {
  const command = lastCommand(text);
  const word = commandOf(command.replace(/<<<\s*$/, ''));
  if (/<<<\s*$/.test(command)) return readsScript(word);
  return kindOf(word) === 'shell' && /^(?:eval|ssh)(?=\s|$)|\s-[a-zA-Z]*c[a-zA-Z]*$/.test(word);
}

// Who reads a heredoc body: the command the operator belongs to and each command piped after it.
// Only data sinks leave the body as data; whatever is not recognised is read as code.
function heredocConsumer(header, line) {
  const [first, ...piped] = line.split(/(?<!\|)\|(?!\|)/);
  const commands = [
    lastCommand(header) + ' ' + first.split(/[;&]/)[0],
    // A pipe at the end of the line names its consumer on a later line.
    ...piped.map((command) => command.split(/[;&]/)[0].trim() || '|'),
  ];
  const kinds = commands.map((command) => kindOf(commandOf(command)));
  if (kinds.some((kind) => kind === 'shell' || kind === 'other')) return 'code';
  return kinds.includes('interpreter') ? 'interpreter' : 'data';
}

// The head of a real case statement: the word `case` among another command's arguments is not one.
const CASE = /^case\s+(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;|&()<>"'])+\s+in\b/;

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

export function shellSource(
  source,
  { maskQuotes = false, step = 'shell script', prose = false } = {},
) {
  source = withoutExpressions(source, step);
  const fail = (what) => {
    throw new Error(`${step}: unterminated ${what}`);
  };
  const substitutions = [];
  const quoted = (start, quote, ansi = false, code = false) => {
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\' && (quote !== "'" || ansi)) {
        i += 2;
        continue;
      }
      if (source[i] === quote) return i + 1;
      if (quote === '"' && source.startsWith('$(', i) && !source.startsWith('$((', i)) {
        const nested = scan(i + 2, ')', false, code);
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
  const arithmetic = (start, open = '(', close = ')', depth = 2) => {
    for (let i = start; i < source.length; i++) {
      if (source[i] === open) depth++;
      if (source[i] === close && --depth === 0) return i + 1;
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
  // Scan the shell word at start as code. Returns where the word ends.
  const scanWord = (start) => {
    const word = shellWord(start);
    substitutions.push(shellSource(word.value, { maskQuotes, step }));
    return word.end;
  };
  const isPipe = (i) => source[i] === '|' && source[i - 1] !== '|' && source[i + 1] !== '|';
  const scan = (start, stop = null, parameter = false, code = false) => {
    let result = '';
    let i = start;
    const heredocs = [];
    const cases = [];
    const strings = [];
    let scanned = 0;
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        if (source[i + 1] !== '\n') result += maskQuotes ? '__' : source.slice(i, i + 2);
        i += 2;
      } else if (char === "'" || char === '"' || char === '`' || source.startsWith("$'", i)) {
        const ansi = source.startsWith("$'", i);
        const quoteStart = i + Number(ansi);
        const end = quoted(quoteStart, source[quoteStart], ansi, code || readsCode(result));
        if (char === '`')
          substitutions.push(shellSource(source.slice(i + 1, end - 1), { maskQuotes, step }));
        const literal = source.slice(quoteStart + 1, end - 1);
        const commandName = literal === 'true' && /(?:\|\||&&)\s*$/.test(result);
        if (maskQuotes && char !== '`') {
          strings.push({ at: result.length, start: i });
          if (i >= scanned && readsStrings(result)) scanned = scanWord(i);
        }
        result += maskQuotes ? (commandName ? literal : '_'.repeat(end - i)) : source.slice(i, end);
        i = end;
      } else if (source.startsWith('$((', i) || (!parameter && source.startsWith('((', i))) {
        const end = arithmetic(i + (char === '$' ? 3 : 2));
        result += source.slice(i, end);
        i = end;
      } else if (source.startsWith('$[', i)) {
        const end = arithmetic(i + 2, '[', ']', 1);
        result += source.slice(i, end);
        i = end;
      } else if (source.startsWith('${', i)) {
        const nested = scan(i + 2, '}', true);
        result += '${' + nested.text + '}';
        i = nested.end;
      } else if (source.startsWith('$(', i) || (!parameter && char === '(')) {
        const size = char === '$' ? 2 : 1;
        const nested = scan(i + size, ')', false, code || readsCode(result));
        result += source.slice(i, i + size) + nested.text + ')';
        i = nested.end;
      } else if (!parameter && char === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]))) {
        while (i < source.length && source[i] !== '\n') i++;
      } else if (source.startsWith('<<<', i)) {
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
        heredocs.push({
          delimiter: word.value,
          quotedWord: word.quotedWord,
          tabs,
          consumer: code ? 'code' : heredocConsumer(source.slice(start, i), line),
        });
        result += maskQuotes ? '<<_' : source.slice(i, word.end);
        i = word.end;
      } else if (char === '\n') {
        result += source[i++];
        for (const { delimiter, tabs, quotedWord, consumer } of heredocs.splice(0)) {
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
          // Bash expands an unquoted body before its consumer reads it: those expansions run here.
          const inline = (options) =>
            '\n' +
            shellSource(body, { maskQuotes, step, ...options }).replaceAll('\0', '\n') +
            '\n';
          if (!quotedWord) result += inline({ prose: true });
          if (consumer === 'code') result += inline();
          else if (consumer === 'interpreter' && !maskQuotes) result += '\n' + body + '\n';
        }
      } else if (!parameter && (source.startsWith(';;', i) || source.startsWith(';&', i))) {
        if (cases.length) cases.at(-1).pattern = true;
        result += ';;';
        i += 2;
      } else if (maskQuotes && !parameter && isPipe(i)) {
        // The strings of the command before a pipe into a shell are the script that shell runs.
        const [next] = source
          .slice(i + 1)
          .trimStart()
          .split(/[;&|\n]/, 1);
        if (readsScript(commandOf(next))) {
          const from = result.length - lastCommand(result).length;
          let end = 0;
          for (const { at, start } of strings)
            if (at >= from && start >= end) end = scanWord(start);
        }
        result += char;
        i++;
      } else if (char === ')' && cases.at(-1)?.pattern) {
        cases.at(-1).pattern = false;
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
        // A case among arguments is no statement; at a command position anything may follow it.
        if (word === 'case' && (CASE.test(rest) || (/^case\s/.test(rest) && atCommand(result))))
          cases.push({ pattern: false });
        if (word === 'in' && cases.length) cases.at(-1).pattern = true;
        if (word === 'esac') cases.pop();
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
  // An unquoted heredoc body is text to the script that holds it: only its expansions run.
  const expansions = () => {
    let result = '';
    for (let i = 0; i < source.length;) {
      let end = i + 1;
      if (source[i] === '\\') end = i + 2;
      else if (source.startsWith('$((', i) || source.startsWith('$[', i)) {
        end = source[i + 1] === '[' ? arithmetic(i + 2, '[', ']', 1) : arithmetic(i + 3);
        result += '\n' + source.slice(i, end);
      } else if (source.startsWith('${', i)) {
        const nested = scan(i + 2, '}', true);
        result += '\n${' + nested.text + '}';
        end = nested.end;
      } else if (source.startsWith('$(', i)) {
        const nested = scan(i + 2, ')');
        result += '\n$(' + nested.text + ')';
        end = nested.end;
      } else if (source[i] === '`') {
        end = quoted(i, '`');
        substitutions.push(shellSource(source.slice(i + 1, end - 1), { maskQuotes, step }));
        result += '\n' + (maskQuotes ? '_'.repeat(end - i) : source.slice(i, end));
      }
      i = end;
    }
    return result;
  };
  const result = prose ? expansions() : scan(0).text;
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
  let cases = 0;
  let loops = 0;
  let functions = 0;
  for (let command of script.replace(/&&\s*true\s*$/, '&& _').split(/&&|\|\||[;\n]/)) {
    command = command.trim().replace(/^[({]\s*/, '');
    if (/^(?:while|until|for|select)\b/.test(command)) loops++;
    if (/^done\b/.test(command)) loops = Math.max(0, loops - 1);
    if (/^(?:\w+\s*\(\)|function\s+\w+(?:\s*\(\))?)\s*(?:\{|$)/.test(command)) functions++;
    if (/^}/.test(command)) functions = Math.max(0, functions - 1);
    if (/^case\b/.test(command)) cases++;
    if (/^esac\b/.test(command)) cases = Math.max(0, cases - 1);
    if (/^fi\b/.test(command)) branches = Math.max(0, branches - 1);
    if (/^if\b/.test(command)) branches++;
    // The keyword or case pattern that opens a body is not the command in it.
    command = command.replace(/^(?:then|else|do)\b\s*/, '');
    if (cases) command = command.replace(/^(?:case\b.*?\bin\s+)?[^)]*\)\s*/, '');
    const disabled =
      /^set\s+(?:\+(?=[abefhkmnptuvxBCEHPT]*e)[abefhkmnptuvxBCEHPT]+(?=\s|$)|\+o\s+errexit(?=\s|$))/.exec(
        command,
      );
    if (disabled) return disabled[0];
    // A bare true is the conventional empty body of a construct; anywhere else it hides a failure.
    if (
      branches === 0 &&
      loops === 0 &&
      functions === 0 &&
      cases === 0 &&
      /^true(?=\s|[)}]|$)/.test(command)
    )
      return 'true';
  }
  return null;
}
