// Conservative lexical filter for workflow safety pins. Uncertain syntax fails closed.
// Keep quoted strings for URL scans, and expose executable substitutions for command scans.
function heredocConsumer(header) {
  // Recognize the command, including common dispatch wrappers, rather than an argument to echo.
  const command = header
    .split(/[;|&\n]/)
    .at(-1)
    .trim()
    .replace(/^(?:[A-Za-z_]\w*=\S+\s+|env\s+|command\s+|exec\s+)+/, '');
  const shell = /^(?:['"]?(?:\/[^\s'"/]+)*\/?)?(?:bash|sh|dash|ksh|zsh|ssh)\b/;
  if (shell.test(command) || /^docker\s+exec\b.*\s(?:bash|sh|dash|ksh|zsh)(?:\s|$)/.test(command))
    return 'shell';
  if (/^(?:['"]?(?:\/[^\s'"/]+)*\/?)?(?:node|python[\d.]*|psql|ruby|perl|php)\b/.test(command))
    return 'interpreter';
  return 'data';
}

export function shellSource(source, { maskQuotes = false, step = 'shell script' } = {}) {
  const fail = (what) => {
    throw new Error(`${step}: unterminated ${what}`);
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
  // A delimiter is a shell word: quote removal applies even to mixed quoted/unquoted words.
  const delimiterWord = (start) => {
    let i = start;
    let delimiter = '';
    let quotedWord = false;
    while (i < source.length && !/[\s;|&()<>]/.test(source[i])) {
      if (source[i] === "'" || source[i] === '"') {
        const end = quoted(i, source[i]);
        delimiter += source.slice(i + 1, end - 1);
        quotedWord = true;
        i = end;
      } else if (source[i] === '\\') {
        quotedWord = true;
        if (i + 1 >= source.length) fail('heredoc delimiter');
        delimiter += source[i + 1];
        i += 2;
      } else delimiter += source[i++];
    }
    if (i === start) fail('heredoc delimiter');
    return { delimiter, quotedWord, end: i };
  };
  const scan = (start, stop = null, parameter = false) => {
    let result = '';
    let i = start;
    const heredocs = [];
    const cases = [];
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
        result += maskQuotes ? (commandName ? literal : '_'.repeat(end - i)) : source.slice(i, end);
        i = end;
      } else if (source.startsWith('$((', i) || source.startsWith('((', i)) {
        const end = arithmetic(i + (char === '$' ? 3 : 2));
        result += source.slice(i, end);
        i = end;
      } else if (source.startsWith('${', i)) {
        const nested = scan(i + 2, '}', true);
        result += '${' + nested.text + '}';
        i = nested.end;
      } else if (source.startsWith('$(', i) || char === '(') {
        const size = char === '$' ? 2 : 1;
        const nested = scan(i + size, ')');
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
        const word = delimiterWord(wordStart);
        heredocs.push({ ...word, tabs, consumer: heredocConsumer(source.slice(start, i)) });
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
          if (consumer === 'shell' || (!quotedWord && /(?<!\\)(?:\$\(|`)/.test(body))) {
            result += '\n' + shellSource(body, { maskQuotes, step }) + '\n';
          } else if (consumer === 'interpreter' && !maskQuotes) result += '\n' + body + '\n';
        }
      } else if (!parameter && source.startsWith(';;', i)) {
        if (cases.length) cases.at(-1).pattern = true;
        result += ';;';
        i += 2;
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
        const word = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(source.slice(i))[0];
        if (word === 'case') cases.push({ pattern: false });
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
  const result = scan(0).text;
  return result + (maskQuotes ? substitutions.map((code) => '\n' + code).join('') : '');
}

export function swallowedFailure(source, options = {}) {
  const script = shellSource(source, { ...options, maskQuotes: true });
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
  for (let command of script.replace(/&&\s*true\s*$/, '&& _').split(/&&|\|\||[;\n]/)) {
    command = command.trim().replace(/^[({]\s*/, '');
    if (/^case\b/.test(command)) cases++;
    if (/^esac\b/.test(command)) cases = Math.max(0, cases - 1);
    if (/^fi\b/.test(command)) branches = Math.max(0, branches - 1);
    if (/^if\b/.test(command)) branches++;
    // A true branch is a conventional empty conditional body. A case pattern `true)`
    // and an argument containing true are not standalone success commands either.
    command = command.replace(/^(?:then|else|do)\b\s*/, '');
    if (cases) command = command.replace(/^(?:case\b.*?\bin\s+)?[^)]*\)\s*/, '');
    const disabled =
      /^set\s+(?:\+(?=[abefhkmnptuvxBCEHPT]*e)[abefhkmnptuvxBCEHPT]+(?=\s|$)|\+o\s+errexit(?=\s|$))/.exec(
        command,
      );
    if (disabled) return disabled[0];
    if (branches === 0 && !(cases && /^true\)/.test(command)) && /^true(?=\s|[)}]|$)/.test(command))
      return 'true';
  }
  return null;
}
