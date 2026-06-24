'use client';

/**
 * Collapsible JSON tree for fenced ```json blocks in model prose.
 *
 * Rendered by PreBlock (markdown-view) when a fence is tagged json/jsonc/json5,
 * or is an unlabeled fence whose body strictly parses as JSON. Malformed JSON
 * never reaches here — PreBlock falls back to <pre> on parse failure.
 *
 * Uncontrolled <details> per node (no React open-state): the initial `open`
 * flag is a pure function of depth + entry count, so it stays constant across
 * the parent's re-renders. React therefore applies `open` once on mount and
 * never overwrites the user's manual toggle — the same reason MarkdownView's
 * Expand-all/Collapse-all DOM mutation is safe on the surrounding <details>.
 * Nodes are keyed by object key / array index so reconciliation is stable.
 *
 * Rendered inside the .haive-md container, so summaries inherit the cursor,
 * user-select, color and open-animation from globals.css and show the browser's
 * default disclosure triangle (same affordance as .haive-code-details).
 */

/** Auto-expand containers shallower than this; deeper ones start collapsed. */
const AUTO_OPEN_DEPTH = 2;
/** Auto-collapse a container with more entries than this, at any depth — keeps
 *  large fix-loop payloads from rendering thousands of open nodes at once. */
const AUTO_OPEN_MAX_ENTRIES = 100;

export function JsonTreeBlock({ value }: { value: unknown }) {
  return (
    <div className="haive-json-tree my-2 overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-[12px] leading-relaxed text-neutral-200">
      <JsonNode value={value} depth={0} />
    </div>
  );
}

function Label({ name, index }: { name?: string; index?: boolean }) {
  if (name === undefined) return null;
  return <span className={index ? 'text-neutral-500' : 'text-sky-300'}>{name}: </span>;
}

function JsonNode({
  name,
  index,
  value,
  depth,
}: {
  name?: string;
  /** True when `name` is an array index, so it renders dimmer than object keys. */
  index?: boolean;
  value: unknown;
  depth: number;
}) {
  if (value === null || typeof value !== 'object') {
    return (
      <div>
        <Label name={name} index={index} />
        <PrimitiveToken value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';

  if (entries.length === 0) {
    return (
      <div>
        <Label name={name} index={index} />
        <span className="text-neutral-500">
          {open}
          {close}
        </span>
      </div>
    );
  }

  const noun = isArray ? 'item' : 'key';
  const count = `${entries.length} ${noun}${entries.length === 1 ? '' : 's'}`;
  const initiallyOpen = depth < AUTO_OPEN_DEPTH && entries.length <= AUTO_OPEN_MAX_ENTRIES;

  return (
    <details open={initiallyOpen} className="haive-json-node">
      <summary className="whitespace-nowrap">
        <Label name={name} index={index} />
        <span className="text-neutral-500">{open}</span>
        <span className="text-neutral-600"> {count} </span>
        <span className="text-neutral-500">{close}</span>
      </summary>
      <div className="ml-1 border-l border-neutral-800 pl-3">
        {entries.map(([k, v]) => (
          <JsonNode key={k} name={k} index={isArray} value={v} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

function PrimitiveToken({ value }: { value: unknown }) {
  if (value === null) return <span className="text-neutral-500">null</span>;
  switch (typeof value) {
    case 'string':
      // JSON.stringify gives the canonical quoted+escaped token; React renders
      // it as text, so embedded HTML in the string is never interpreted.
      return <span className="break-all text-green-300">{JSON.stringify(value)}</span>;
    case 'number':
      return <span className="text-amber-400">{String(value)}</span>;
    case 'boolean':
      return <span className="text-purple-400">{value ? 'true' : 'false'}</span>;
    default:
      // Not reachable for JSON.parse output (no bigint/undefined/function); kept
      // as a defensive fallback so an unexpected value still renders as text.
      return <span className="text-neutral-300">{String(value)}</span>;
  }
}
