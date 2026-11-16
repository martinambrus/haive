import type { InvocationReadExposure, ReadExposureCount } from '@haive/shared';

export const READ_EXPOSURE_VERSION = 1;
export const READ_EXPOSURE_FILE_LIMIT = 50;

type Paths = string[] | 'unattributed' | null;
type Target = { kind: 'file'; path: string } | { kind: 'outside' | 'multiFile' | 'unattributed' };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const empty = (): ReadExposureCount => ({ reads: 0, chars: 0, weightedChars: 0 });
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lexical only. No filesystem access, shell evaluation, glob expansion or cwd guessing. */
export function normalizeReadPath(raw: string, workdir: string | null): string | null {
  const resolve = (path: string): string[] => {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !path.startsWith('/')) parts.push(part);
    }
    return parts;
  };
  let path = raw.trim();
  if (!path) return null;
  let parts = resolve(path);
  if (path.startsWith('/')) {
    if (workdir === null) return null;
    const root = resolve(workdir);
    if (!root.every((p, i) => parts[i] === p)) return null;
    parts = parts.slice(root.length);
  }
  if (parts[0] === '..') return null;
  if (parts[0] === '.haive' && parts[1] === 'worktrees' && parts.length > 3) parts = parts.slice(3);
  path = parts.join('/');
  return path || null;
}

/** Only the small reader grammar we can attribute. Pipelines and expansions keep their
 * combined output unattributed; an arbitrary command is never inferred to be a file read. */
export function readerCommandPaths(command: unknown): Paths {
  if (typeof command !== 'string') return null;
  const wrapper = /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/.exec(
    command.trim(),
  );
  if (wrapper) {
    const inner = wrapper[2]!;
    // A quoted shell argument, not a general shell parser. Nested wrappers and escaped
    // quote concatenation remain unknown instead of evaluating arbitrary shell syntax.
    if (inner.includes(wrapper[1]!) || /^(?:\/bin\/)?(?:bash|sh)\s/.test(inner))
      return 'unattributed';
    return readerCommandPaths(inner);
  }
  if (!/(?:^|[\s;&|])(?:\/(?:usr\/)?bin\/)?(?:cat|sed|head|tail|nl)(?:\s|$)/.test(command))
    return null;
  if (/[$`*?\n]|\|[^|]|[(){}]/.test(command)) return 'unattributed';
  // Tokens retain quoted spaces. Reject unmatched quotes rather than guessing.
  const tokens: string[] = [];
  let token = '',
    quote = '',
    active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else token += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      active = true;
    } else if (c === '\\') return 'unattributed';
    else if (/\s/.test(c)) {
      if (active) tokens.push(token);
      token = '';
      active = false;
    } else if (';&<>|'.includes(c)) {
      if (active) tokens.push(token);
      token = '';
      active = false;
      const next = command[i + 1];
      if (next === c) {
        tokens.push(c + c);
        i++;
      } else tokens.push(c);
    } else {
      token += c;
      active = true;
    }
  }
  if (quote) return 'unattributed';
  if (active) tokens.push(token);
  const segments: string[][] = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (['>', '>>', '<', '<<'].includes(t)) {
      const current = segments.at(-1)!;
      if (/^\d+$/.test(current.at(-1) ?? '')) current.pop();
      if (!tokens[++i] || tokens[i] === '&') return 'unattributed';
    } else if (['&&', ';'].includes(t)) segments.push([]);
    else if (['&', '||', '|'].includes(t)) return 'unattributed';
    else segments.at(-1)!.push(t);
  }
  const paths: string[] = [];
  for (const segment of segments) {
    if (!segment.length) continue;
    const name = segment[0]!.replace(/^\/(?:usr\/)?bin\//, '');
    if (!['cat', 'sed', 'head', 'tail', 'nl'].includes(name)) return 'unattributed';
    if (
      name === 'sed' &&
      !segment.slice(1).some((t) => t === '-n' || t === '--quiet' || t === '--silent')
    )
      return 'unattributed';
    let script = name !== 'sed';
    let options = true;
    for (let i = 1; i < segment.length; i++) {
      const t = segment[i]!;
      if (options && t === '--') {
        options = false;
        continue;
      }
      if (options && t.startsWith('-')) {
        if (['-e', '--expression'].includes(t) && name === 'sed') {
          i++;
          script = true;
        } else if (
          ['-n', '-c', '--lines', '--bytes'].includes(t) &&
          ['head', 'tail'].includes(name)
        )
          i++;
        else if (
          ['-s', '-w', '-v', '-i', '-b', '-d', '-f', '-h', '-l'].includes(t) &&
          name === 'nl'
        )
          i++;
        else if (!/^(?:-n|--quiet|--silent|-[0-9]+|-[bEnstuvAT]+|-[ba]+)$/.test(t))
          return 'unattributed';
        continue;
      }
      if (!script) {
        script = true;
        continue;
      }
      if (t === '-') return 'unattributed';
      paths.push(t);
    }
  }
  return paths.length ? paths : 'unattributed';
}

/** Count textual content, excluding images and serialization metadata. */
function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (n: number, b: unknown) => n + (record(b) && typeof b.text === 'string' ? b.text.length : 0),
    0,
  );
}

export function createReadExposure(opts: { workdir: string | null; readFileLimit?: number }) {
  const limit = opts.readFileLimit ?? READ_EXPOSURE_FILE_LIMIT;
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error('readFileLimit must be a nonnegative integer');
  const calls = new Map<string, { tool: string; target: Target | null }>();
  const resultsSeen = new Set<string>();
  const messages = new Set<string>();
  const boundaries = new Set<string>();
  const contexts = new Map<
    string,
    { turns: number; pending: Array<{ chars: number; at: number; counts: ReadExposureCount[] }> }
  >();
  const files = new Map<string, ReadExposureCount>();
  const byTool = new Map<string, ReadExposureCount>();
  const results = empty(),
    fileReads = empty(),
    outside = empty(),
    multiFile = empty(),
    unattributed = empty();
  let observable = false,
    unknownTurns = false,
    compactions = 0,
    resultSeen = false;
  const context = (key: string) => {
    let c = contexts.get(key);
    if (!c) {
      c = { turns: 0, pending: [] };
      contexts.set(key, c);
    }
    return c;
  };
  const settle = (c: ReturnType<typeof context>) => {
    for (const p of c.pending)
      for (const count of p.counts) count.weightedChars! += p.chars * (c.turns - p.at);
    for (const p of c.pending) p.at = c.turns;
  };
  const snapshot = (c: ReadExposureCount, known: boolean): ReadExposureCount => ({
    ...c,
    weightedChars: known ? c.weightedChars : null,
  });
  return {
    observe() {
      observable = true;
    },
    tool(id: string, tool: string, paths: Paths) {
      observable = true;
      let target: Target | null = null;
      if (paths === 'unattributed') target = { kind: 'unattributed' };
      else if (paths?.length) {
        const normalized = paths.map((p) => normalizeReadPath(p, opts.workdir));
        // Multiple paths share one output. Mixed inside/outside output cannot be
        // apportioned to the repository, and stays unattributed.
        target = normalized.every((p) => p === null)
          ? { kind: 'outside' }
          : normalized.some((p) => p === null)
            ? { kind: 'unattributed' }
            : normalized.length > 1
              ? { kind: 'multiFile' }
              : { kind: 'file', path: normalized[0]! };
      }
      calls.set(id, { tool, target });
    },
    assistant(id: unknown, key: string) {
      observable = true;
      if (typeof id !== 'string' || !id) {
        unknownTurns = true;
        return;
      }
      const stable = JSON.stringify([key, id]);
      if (messages.has(stable)) return;
      messages.add(stable);
      context(key).turns++;
    },
    result(id: string, content: unknown, key: string) {
      if (resultsSeen.has(id)) return;
      resultsSeen.add(id);
      observable = true;
      const call = calls.get(id);
      const counts = [results];
      const tool = call?.tool ?? 'unknown';
      if (!byTool.has(tool)) byTool.set(tool, empty());
      counts.push(byTool.get(tool)!);
      if (call?.target) {
        const t = call.target;
        if (t.kind === 'file') {
          if (!files.has(t.path)) files.set(t.path, empty());
          counts.push(files.get(t.path)!, fileReads);
        } else {
          counts.push(
            t.kind === 'outside' ? outside : t.kind === 'multiFile' ? multiFile : unattributed,
          );
          if (t.kind === 'multiFile') counts.push(fileReads);
        }
      }
      const chars = textChars(content);
      for (const count of counts) {
        count.reads++;
        count.chars += chars;
      }
      const c = context(key);
      c.pending.push({ chars, at: c.turns, counts });
    },
    compaction(id: unknown, key: string) {
      if (typeof id === 'string') {
        if (boundaries.has(id)) return;
        boundaries.add(id);
      }
      compactions++;
      const c = context(key);
      settle(c);
      c.pending = [];
    },
    resultSeen() {
      resultSeen = true;
    },
    unknownTurns() {
      unknownTurns = true;
    },
    finalize(elided = false): InvocationReadExposure {
      for (const c of contexts.values()) settle(c);
      const known = observable && !unknownTurns && messages.size > 0 && !elided;
      const ranked = [...files]
        .map(([path, c]) => ({ path, ...snapshot(c, known) }))
        .sort(
          (a, b) =>
            (b.weightedChars ?? 0) - (a.weightedChars ?? 0) ||
            b.chars - a.chars ||
            compare(a.path, b.path),
        );
      const omitted = ranked.slice(limit);
      const overflow = empty();
      for (const f of omitted) {
        overflow.reads += f.reads;
        overflow.chars += f.chars;
        overflow.weightedChars! += f.weightedChars ?? 0;
      }
      return {
        version: READ_EXPOSURE_VERSION,
        coverage: !observable ? 'none' : elided ? 'partial' : 'full',
        turns: known ? messages.size : null,
        compactions,
        resultSeen,
        results: snapshot(results, known),
        fileReads: snapshot(fileReads, known),
        files: ranked.slice(0, limit),
        outside: snapshot(outside, known),
        multiFile: snapshot(multiFile, known),
        unattributed: snapshot(unattributed, known),
        overflow: { ...snapshot(overflow, known), omitted: omitted.length },
        byTool: Object.fromEntries(
          [...byTool]
            .sort(([a], [b]) => compare(a, b))
            .map(([name, count]) => [name, snapshot(count, known)]),
        ),
      };
    },
  };
}
