// Small lexical filter for the workflow pins, not a shell parser. Heredoc data and comments
// are not commands. Preserve quoted strings for URL scans; mask them for command scans.
export function shellSource(source, { maskQuotes = false } = {}) {
  let result = '';
  const heredocs = [];
  const substitutions = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === '\\') {
      if (source[i + 1] !== '\n') {
        result += maskQuotes ? '__' : source.slice(i, i + 2);
      }
      i += 2;
    } else if (char === "'" || char === '"' || char === '`') {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\' && char !== "'") i += 2;
        else if (char === '"' && source.startsWith('$(', i)) {
          const end = substitutionEnd(source, i + 2);
          substitutions.push(source.slice(i + 2, end));
          i = end + 1;
        } else if (source[i++] === char) break;
      }
      if (char === '`') substitutions.push(source.slice(start + 1, i - 1));
      const quoted = source.slice(start, i);
      result += maskQuotes ? '_'.repeat(quoted.length) : quoted;
    } else if (char === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source.startsWith('<<', i) && source[i + 2] !== '<') {
      const match = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([\w-]+))/.exec(source.slice(i));
      if (match) {
        heredocs.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: match[1] === '-' });
        result += maskQuotes ? '<<_' : match[0];
        i += match[0].length;
      } else {
        result += source[i++];
      }
    } else if (char === '\n') {
      result += source[i++];
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        while (i < source.length) {
          const end = source.indexOf('\n', i);
          const next = end === -1 ? source.length : end;
          const line = source.slice(i, next);
          i = end === -1 ? source.length : end + 1;
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
    } else {
      result += source[i++];
    }
  }
  return (
    result +
    (maskQuotes
      ? substitutions.map((code) => '\n' + shellSource(code, { maskQuotes })).join('')
      : '')
  );
}

// Find the end of a $(...) inside a double-quoted argument without mistaking a
// quoted parenthesis or a nested substitution for its closing parenthesis.
function substitutionEnd(source, start) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'") i++;
    else if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return source.length;
}

export function swallowedFailure(source) {
  const script = shellSource(source, { maskQuotes: true });
  const fallback = /\|\|\s*(?:true(?=\s|;|$)|:(?=\s|;|$)|exit\s+0(?=\s|;|$))/.exec(script);
  if (fallback) return fallback[0].replace(/\s+/g, ' ').trim();
  let branches = 0;
  let cases = 0;
  for (let command of script.split(/[;\n]/)) {
    command = command.trim();
    if (/^case\b/.test(command)) cases++;
    if (/^esac\b/.test(command)) cases = Math.max(0, cases - 1);
    if (/^fi\b/.test(command)) branches = Math.max(0, branches - 1);
    if (/^then\b/.test(command)) branches++;
    // A true branch is a conventional empty conditional body. A case pattern `true)`
    // and an argument containing true are not standalone success commands either.
    command = command.replace(/^(?:then|else)\s*/, '');
    const disabled = /^set\s+\+e(?=\s|$)/.exec(command);
    if (disabled) return disabled[0];
    if (branches === 0 && !(cases && /^true\)/.test(command)) && /^true(?=\s|[)}]|$)/.test(command))
      return 'true';
  }
  return null;
}
