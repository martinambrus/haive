'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { getRepoFile } from '@/lib/api-client';
import { Dialog, DialogContent } from '@/components/dialog';
import { FormError } from '@/components/ui';
import { languageForPath, resolvePreviewLine } from './code-preview-source';

export function CodePreviewDialog({
  repositoryId,
  repoPath,
  symbol,
  evidence,
  open,
  onOpenChange,
}: {
  repositoryId: string;
  repoPath: string;
  symbol: string | null;
  /** What the agent said when it made the link. Sometimes it names the line
   *  outright, which beats anything derivable from the symbol. */
  evidence?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof getRepoFile>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFile(null);
    setError(null);
    void getRepoFile(repositoryId, repoPath)
      .then((f) => !cancelled && setFile(f))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to read file'));
    return () => {
      cancelled = true;
    };
  }, [open, repositoryId, repoPath]);

  const line = file?.content ? resolvePreviewLine(file.content, symbol, evidence) : null;

  // Where the located line sits inside the scroll container, in px, measured
  // ONCE so the scroll position and the marker are the same number.
  //
  // Measured with a Range over the rendered text rather than computed as
  // lineHeight * (line - 1): that arithmetic assumes the first line starts
  // exactly at the code element's box and that no line ever wraps, and it put
  // the first version half a line above what it was pointing at.
  const [lineBox, setLineBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!line || !file?.content) {
      setLineBox(null);
      return;
    }
    let cancelled = false;
    const measure = (): void => {
      if (cancelled) return;
      const host = scrollRef.current;
      const code = codeRef.current?.querySelector('code');
      if (!host || !code) return;

      // First printable character of the target line. The highlighter splits the
      // file across many text nodes, so the walk counts newlines across all of
      // them rather than trusting one node to hold a whole line.
      let current = 1;
      let hit: { node: Text; offset: number } | null = null;
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node && !hit) {
        const text = node.data;
        for (let i = 0; i < text.length; i++) {
          if (current === line && text[i] !== '\n' && text[i] !== '\r') {
            hit = { node, offset: i };
            break;
          }
          if (text[i] === '\n') current++;
        }
        node = walker.nextNode() as Text | null;
      }
      if (!hit) return;

      const range = document.createRange();
      range.setStart(hit.node, hit.offset);
      range.setEnd(hit.node, hit.offset + 1);
      const rect = range.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(code).lineHeight);
      const height = Number.isFinite(lh) ? lh : rect.height;
      // The glyph box is shorter than the line box; centre the band on it so the
      // marker covers the line rather than sitting on its ascender.
      const lead = (height - rect.height) / 2;

      // Anchored to the CODE box, not to the scroll container: the <pre> sits a
      // margin's worth inside the scroller, and measuring against the scroller
      // put the band exactly that far above the line. Both terms now move
      // together, so any padding or margin cancels out.
      const anchor = codeRef.current;
      if (!anchor) return;
      setLineBox({ top: rect.top - anchor.getBoundingClientRect().top - lead, height });

      // A third of the way down rather than at the very top: the lines above a
      // definition are usually what explains it.
      host.scrollTop = Math.max(
        0,
        rect.top - host.getBoundingClientRect().top + host.scrollTop - lead - host.clientHeight / 3,
      );
    };

    // After a frame, and again once the monospace face has loaded: measuring on
    // the commit alone read the pre-swap metrics and landed the marker most of
    // a line above the code it points at.
    const frame = requestAnimationFrame(measure);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [line, file]);

  const lang = languageForPath(repoPath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="w-[95vw] max-w-5xl">
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm text-neutral-100">{repoPath}</p>
            <p className="text-[11px] text-neutral-500">
              {symbol
                ? `${symbol}${line ? ` · line ${line}` : ' · not found in this checkout'}`
                : ''}
              {file?.truncated && ' · truncated'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-sm text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        <FormError message={error} />

        {!file && !error && <p className="text-sm text-neutral-500">Loading…</p>}
        {file?.binary && <p className="text-sm text-neutral-500">This file is not text.</p>}

        {file?.content && (
          <div ref={scrollRef} className="haive-md min-h-0 flex-1 overflow-auto">
            <div ref={codeRef} className="relative">
              {lineBox && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bg-indigo-500/20"
                  style={{ top: `${lineBox.top}px`, height: `${lineBox.height}px` }}
                />
              )}
              <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                {`\`\`\`${lang}\n${file.content}\n\`\`\``}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
