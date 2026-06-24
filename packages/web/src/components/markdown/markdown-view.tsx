'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Element, ElementContent } from 'hast';
import { cn } from '@/lib/cn';
import { segmentMarkdownBody, type Segment } from './markdown-segments';
import { QuizBlock } from './quiz-block';
import { MermaidBlock } from './mermaid-block';
import { BeforeAfterBlock, BeforeAfterPanel } from './before-after-block';
import { JsonTreeBlock } from './json-tree-block';
import { downloadMarkdownHtml } from './export-html';

/** Heuristic markdown detection — true when the body has a heading line, a fenced
 *  code block, an inline code span `` `x` ``, a bold run `**x**`, or a Markdown link
 *  `[text](url)`. Stays conservative on bare "- " lists and single `*`/`_` emphasis
 *  (which collide with plain text — bullet-looking prose, arithmetic, snake_case
 *  names) to avoid false positives; paired backticks / `**bold**` / a full link with
 *  parens are specific enough to be safe signals. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^\s*#{1,6}\s+\S/m.test(text) ||
    /^\s*```/m.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /\*\*[^\n]+?\*\*/.test(text) ||
    /\[[^\]\n]+\]\([^)\s]+\)/.test(text)
  );
}

/** Fenced code blocks longer than this render collapsed inside <details>. */
const COLLAPSE_LINES = 12;

function textOf(nodes: ElementContent[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'element') out += textOf(n.children);
  }
  return out;
}

function fenceLanguage(node: Element | undefined): string | null {
  const code = node?.children?.[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code') return null;
  const className = code.properties?.className;
  if (!Array.isArray(className)) return null;
  for (const cls of className) {
    const m = /^language-(.+)$/.exec(String(cls));
    if (m) return m[1]!;
  }
  return null;
}

/** When a fenced block strictly parses as JSON, PreBlock renders it as a
 *  collapsible tree instead of a flat <pre>. Eligible fences: tagged
 *  json/jsonc/json5, or an unlabeled fence whose body opens with `{`/`[`.
 *  Anything that fails JSON.parse (truncated, NDJSON, comments, trailing
 *  commas) returns null and falls through to the normal <pre>. The wrapper
 *  object lets a valid parse of `null`/`false`/`0` be told apart from "not
 *  JSON". */
const JSON_FENCE_LANGS = new Set(['json', 'jsonc', 'json5']);
function parseJsonFence(lang: string | null, raw: string): { value: unknown } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const eligible =
    lang !== null ? JSON_FENCE_LANGS.has(lang) : trimmed[0] === '{' || trimmed[0] === '[';
  if (!eligible) return null;
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return null;
  }
}

type PreProps = React.ComponentPropsWithoutRef<'pre'> & ExtraProps;

/** react-markdown v10 only produces <pre> for fenced code blocks, so this is
 *  the reliable interception point (there is no `inline` prop in v10).
 *  mermaid fences render as diagrams; unpaired before/after fences as a
 *  single tinted panel; long fences collapse into an UNCONTROLLED <details>
 *  (no `open` prop) so the expand/collapse-all DOM mutation doesn't fight
 *  React. */
function PreBlock({ node, children, ...rest }: PreProps) {
  const lang = fenceLanguage(node);
  const raw = textOf(node?.children).replace(/\n$/, '');
  if (lang === 'mermaid') return <MermaidBlock source={raw} />;
  if (lang === 'before' || lang === 'after') return <BeforeAfterPanel side={lang} code={raw} />;
  const json = parseJsonFence(lang, raw);
  if (json) return <JsonTreeBlock value={json.value} />;
  const lines = raw.length === 0 ? 0 : raw.split('\n').length;
  if (lines > COLLAPSE_LINES) {
    return (
      <details className="haive-code-details">
        <summary>
          Show code — {lines} lines{lang ? ` (${lang})` : ''}
        </summary>
        <pre {...rest}>{children}</pre>
      </details>
    );
  }
  return <pre {...rest}>{children}</pre>;
}

const MD_COMPONENTS: Components = {
  pre: PreBlock,
  // Links inside info content open in a new tab so following a reference never
  // navigates away from (and loses) the task/form the user is in.
  a({ node: _node, children, ...rest }) {
    return (
      <a {...rest} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

function hasCollapsibleContent(segments: Segment[]): boolean {
  return segments.some((segment) => {
    if (segment.kind !== 'markdown') return false;
    // Cheap line-count scan over fences in the raw text — mirrors PreBlock.
    const lines = segment.text.split('\n');
    let inFence = false;
    let count = 0;
    let lang = '';
    for (const line of lines) {
      const open = /^\s*```(\S*)\s*$/.exec(line);
      if (!inFence && open) {
        inFence = true;
        count = 0;
        lang = open[1] ?? '';
        continue;
      }
      if (inFence && /^\s*```\s*$/.test(line)) {
        inFence = false;
        if (count > COLLAPSE_LINES && lang !== 'mermaid' && lang !== 'before' && lang !== 'after')
          return true;
        continue;
      }
      if (inFence) count += 1;
    }
    return false;
  });
}

/** Markdown renderer for infoSection bodies. `enhanced` (default) upgrades
 *  the spec's authoring conventions: interactive comprehension quiz, mermaid
 *  diagrams, side-by-side before/after pairs, collapsed long code blocks
 *  with an expand/collapse-all toolbar. Non-spec bodies are unaffected —
 *  without those conventions this renders exactly like plain ReactMarkdown. */
export function MarkdownView({
  body,
  enhanced = true,
  className,
  title,
  toolbar = false,
}: {
  body: string;
  enhanced?: boolean;
  className?: string;
  /** Filename stem for the HTML download and the fullscreen header. */
  title?: string;
  /** Show the hover-revealed Maximize + Download toolbar. Off by default so
   *  existing callers (step summaries, source previews) are unchanged. */
  toolbar?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const segments = useMemo<Segment[]>(
    () => (enhanced ? segmentMarkdownBody(body) : [{ kind: 'markdown', text: body }]),
    [body, enhanced],
  );
  const collapsible = useMemo(
    () => enhanced && hasCollapsibleContent(segments),
    [segments, enhanced],
  );

  const setAll = (open: boolean) => {
    rootRef.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });
  };

  // Esc exits fullscreen (mirrors commit-diff-viewer).
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  // Rendered once and shared across the toolbar/maximize branches so the
  // subtree (and its already-rendered mermaid SVGs) never remounts on toggle.
  const content = (
    <>
      {collapsible && (
        <div data-md-export-skip className="mb-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            Collapse all
          </button>
        </div>
      )}
      {segments.map((segment, i) => {
        if (segment.kind === 'quiz') return <QuizBlock key={i} quiz={segment.quiz} />;
        if (segment.kind === 'before-after') {
          return <BeforeAfterBlock key={i} before={segment.before} after={segment.after} />;
        }
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
            components={MD_COMPONENTS}
          >
            {segment.text}
          </ReactMarkdown>
        );
      })}
    </>
  );

  // Default callers render exactly as before — no wrapper, no toolbar.
  if (!toolbar) {
    return (
      <div ref={rootRef} className={cn('haive-md max-h-96 overflow-auto px-3 py-2', className)}>
        {content}
      </div>
    );
  }

  const onDownload = (): void => {
    if (rootRef.current) downloadMarkdownHtml(title ?? 'document', rootRef.current);
  };

  const btnClass =
    'rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900';

  return (
    <div
      className={
        maximized ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-neutral-950 p-3' : 'group relative'
      }
    >
      {maximized && (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-sm font-medium text-neutral-200">{title ?? 'Document'}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onDownload} className={btnClass}>
              Download
            </button>
            <button type="button" onClick={() => setMaximized(false)} className={btnClass}>
              Exit fullscreen
            </button>
          </div>
        </div>
      )}
      {!maximized && (
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setMaximized(true)}
            className={cn(btnClass, 'pointer-events-auto bg-neutral-950/80')}
          >
            Maximize
          </button>
          <button
            type="button"
            onClick={onDownload}
            className={cn(btnClass, 'pointer-events-auto bg-neutral-950/80')}
          >
            Download
          </button>
        </div>
      )}
      <div
        ref={rootRef}
        className={cn(
          'haive-md overflow-auto px-3 py-2',
          maximized ? 'min-h-0 flex-1' : 'max-h-96',
          className,
        )}
      >
        {content}
      </div>
    </div>
  );
}
