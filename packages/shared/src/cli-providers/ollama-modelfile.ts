type ModelfileParams = Record<string, string | number | (string | number)[]>;

export interface ParsedModelfile {
  from?: string;
  system?: string;
  template?: string;
  parameters: ModelfileParams;
}

/** Coerce a PARAMETER value: ints/floats become numbers (Ollama expects typed
 *  values, e.g. num_ctx), surrounding quotes are stripped, everything else stays
 *  a string. */
function coerceParamValue(raw: string): string | number {
  const v = raw.trim().replace(/^"(.*)"$/, '$1');
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

/** Parse an Ollama Modelfile into the structured fields /api/create expects (it
 *  rejects a raw Modelfile string). Supports FROM, SYSTEM, TEMPLATE (including
 *  multi-line triple-quoted blocks, which carry Go-template `{{ }}` verbatim),
 *  and PARAMETER (repeated keys collapse to an array, e.g. stop). Other
 *  directives (ADAPTER/LICENSE/MESSAGE) are ignored — out of scope for the
 *  no-upload path. */
export function parseModelfile(text: string): ParsedModelfile {
  const lines = text.split(/\r?\n/);
  const parameters: ModelfileParams = {};
  const result: ParsedModelfile = { parameters };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    const directive = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

    // Read a directive value that may be a triple-quoted multi-line block,
    // a single-quoted string, or a bare remainder. Advances `i` past a
    // multi-line block's closing delimiter.
    const readBlock = (): string => {
      if (rest.startsWith('"""')) {
        const afterOpen = rest.slice(3);
        const closeIdx = afterOpen.indexOf('"""');
        if (closeIdx !== -1) return afterOpen.slice(0, closeIdx);
        const buf = [afterOpen];
        i += 1;
        for (; i < lines.length; i += 1) {
          const l = lines[i]!;
          const idx = l.indexOf('"""');
          if (idx !== -1) {
            buf.push(l.slice(0, idx));
            break;
          }
          buf.push(l);
        }
        return buf.join('\n');
      }
      if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
      return rest;
    };

    switch (directive) {
      case 'FROM':
        result.from = rest;
        break;
      case 'SYSTEM':
        result.system = readBlock();
        break;
      case 'TEMPLATE':
        result.template = readBlock();
        break;
      case 'PARAMETER': {
        const m = rest.match(/^(\S+)\s+(.*)$/);
        if (!m) break;
        const key = m[1]!;
        const value = coerceParamValue(m[2]!);
        const existing = parameters[key];
        if (existing === undefined) parameters[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else parameters[key] = [existing, value];
        break;
      }
      default:
        break; // ADAPTER / LICENSE / MESSAGE / unknown — ignored
    }
  }
  return result;
}
