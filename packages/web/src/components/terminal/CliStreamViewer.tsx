'use client';

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { api, apiWebSocketUrl } from '@/lib/api-client';
import { attachWheelScroll } from '@/lib/terminal-wheel';
import { stripDel } from '@/lib/terminal-sanitize';
import { MarkdownView, looksLikeMarkdown } from '@/components/markdown/markdown-view';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';
type TerminalTab = 'clean' | 'raw';

interface CliStreamViewerProps {
  invocationId: string;
  taskId: string;
  /** Called when the CLI stream ends (exit frame received). The page uses
   *  this to switch back to the Steps tab automatically. */
  onExit?: (code: number) => void;
  fill?: boolean;
  /** Override the default 600px height for inline embedding. */
  height?: string;
  /** When provided, render this output statically (no WebSocket, no Cancel
   *  button). Used to replay an ended invocation's persisted stream_log from
   *  cli_invocations.stream_log without keeping a stream alive past the
   *  Redis-stream 600s expiry. */
  staticOutput?: string;
  /** Final exit code annotation for static replays (rendered in cyan after
   *  the buffered output). Ignored when staticOutput is unset. */
  staticExitCode?: number | null;
  /** Persisted model prose for the Clean tab on replay (cli_invocations.raw_output).
   *  Ignored for live runs, which accumulate prose from `text` stream frames. */
  staticCleanOutput?: string;
  /** Whether this invocation produces parsed model prose. False for
   *  subagent_sequential (its rawOutput is a JSON trace, not prose) — those
   *  panels render raw-only with no tab bar. Defaults to true. */
  cleanSupported?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;
// How long the Clean tab may stay empty during a live run before we auto-switch the
// user to the Raw tab. Ollama-class models stream thinking/assistant frames (which
// land in Raw) and may not emit the first parsed `text` frame for a long time,
// leaving an empty Clean tab looking frozen even though the model is working.
const RAW_AUTOSWITCH_IDLE_MS = 30_000;

// How close to the bottom (px) the Clean tab must be for auto-scroll to stay
// engaged. Above this gap we treat the user as having scrolled up to read and
// stop pinning to the latest output until they scroll back to the bottom.
const CLEAN_STICK_THRESHOLD_PX = 24;

// A steer's lifecycle in the viewer. `sent` = accepted by the API (queued to the
// CLI's stdin); `consumed` = drained by the model at a tool-call boundary (the
// worker's steer_consumed frame); `unconsumed` = the run ended before it drained;
// `error` = the API rejected it (e.g. the turn already finished).
type SteerStatus = 'sent' | 'consumed' | 'unconsumed' | 'error';
interface SteerEntry {
  id: string;
  text: string;
  status: SteerStatus;
  error?: string;
}

export function CliStreamViewer({
  invocationId,
  taskId,
  onExit,
  fill = false,
  height,
  staticOutput,
  staticExitCode,
  staticCleanOutput,
  cleanSupported = true,
}: CliStreamViewerProps) {
  const isReplay = staticOutput !== undefined;
  // Suppress the "Loading…" overlay once any byte has been written to xterm.
  // For live runs that means the first output frame; for replays it means
  // the static dump completed (an empty replay still flips this so the
  // overlay doesn't linger on a 0-byte invocation). Drives the centered
  // placeholder rendered absolutely over the terminal mount node.
  const [hasOutput, setHasOutput] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Mid-run steering: enabled only when the connected frame reports this
  // invocation is steerable. The text is delivered to the running CLI's stdin
  // and applied at its next tool-call boundary.
  const [steerable, setSteerable] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  // Sent steers for this invocation (live-session only — a page reload resets it).
  // Rows flip to `consumed` on the worker's steer_consumed frame; any still-`sent`
  // rows flip to `unconsumed` when the run exits.
  const [steers, setSteers] = useState<SteerEntry[]>([]);
  const [steerListOpen, setSteerListOpen] = useState(false);
  const steerListRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);

  // Tabbed view: Clean (parsed model prose) is the default; Raw is the original
  // xterm byte stream. cleanText accumulates live `text` frames; on replay the
  // Clean tab renders staticCleanOutput instead. When cleanSupported is false we
  // render raw-only (no tabs) — unchanged from the pre-tabs behavior.
  const [tab, setTab] = useState<TerminalTab>('clean');
  const [cleanText, setCleanText] = useState('');
  // True once the user clicks either tab on this terminal. Disables all auto-switching
  // for the rest of this terminal's life — a manual choice always wins. Resets per
  // terminal because each invocation mounts a fresh CliStreamViewer (keyed by id).
  const [userPickedTab, setUserPickedTab] = useState(false);
  const cleanScrollRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom gate for the Clean tab. True while the user is at (or near)
  // the bottom; flipped false the moment they scroll up to read, so streaming
  // frames stop yanking them down, and re-armed when they scroll back to the
  // bottom. A ref (not state) — handleCleanScroll fires per frame and must not
  // trigger a re-render.
  const cleanStickRef = useRef(true);
  // Refs to the live terminal + fit addon so the tab-switch effect can re-fit
  // when Raw becomes visible (xterm laid out in a display:none container keeps a
  // zero size until re-fit).
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  // Close the steer-list popover on an outside click.
  useEffect(() => {
    if (!steerListOpen) return;
    const onDown = (e: MouseEvent) => {
      if (steerListRef.current && !steerListRef.current.contains(e.target as Node)) {
        setSteerListOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [steerListOpen]);

  const cancelActiveCli = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.post(`/tasks/${taskId}/cancel-active-cli`, {});
    } catch (err) {
      setCancelError((err as Error).message ?? 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  };

  const sendSteer = async () => {
    const text = steerText.trim();
    if (!text || steering) return;
    const id = crypto.randomUUID();
    setSteering(true);
    try {
      await api.post(`/tasks/${taskId}/steer-active-cli`, { text, invocationId, steerId: id });
      setSteerText('');
      setSteers((prev) => [...prev, { id, text, status: 'sent' }]);
    } catch (err) {
      const msg = (err as Error).message ?? 'Steer failed';
      const friendly = /409|not steerable|no active/i.test(msg)
        ? 'Too late — the run already finished its turn'
        : msg;
      setSteers((prev) => [...prev, { id, text, status: 'error', error: friendly }]);
    } finally {
      setSteering(false);
    }
  };

  useEffect(() => {
    if (!mountRef.current) return;

    // Tracks teardown so async callbacks (deferred fit, resize, WS frames) never
    // touch the terminal after dispose. xterm throws an uncaught
    // "this._renderer.value is undefined" from its internal render path when a
    // fit/refresh/write lands on a disposed terminal.
    let disposed = false;

    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#0a0a0a',
        black: '#0a0a0a',
        brightBlack: '#525252',
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(clipboardAddon);
    termRef.current = term;
    fitRef.current = fitAddon;

    // Read-only viewer: Ctrl+C / Ctrl+Shift+C copy the current selection.
    // There is no CLI-cancel hotkey — cancelling is done via the Cancel
    // button so Ctrl+C never interferes with the standard copy shortcut.
    // (disableStdin already blocks input forwarding.)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      return true;
    });

    term.open(mountRef.current);
    const detachWheel = attachWheelScroll(term);
    let fitRaf1 = 0;
    let fitRaf2 = 0;
    fitRaf1 = requestAnimationFrame(() => {
      fitRaf2 = requestAnimationFrame(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      });
    });

    const handleResize = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
    };
    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(mountRef.current);

    // Replay path: skip WebSocket entirely. Just dump the persisted output
    // into the terminal and annotate the exit code. No keepalive, no cancel.
    if (isReplay) {
      setState('closed');
      if (staticOutput) term.write(stripDel(staticOutput));
      if (typeof staticExitCode === 'number') {
        term.writeln(`\r\n\x1b[36m[CLI exited with code ${staticExitCode}]\x1b[0m`);
      }
      setHasOutput(true);
      return () => {
        disposed = true;
        cancelAnimationFrame(fitRaf1);
        cancelAnimationFrame(fitRaf2);
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        detachWheel();
        termRef.current = null;
        fitRef.current = null;
        term.dispose();
      };
    }

    const ws = new WebSocket(apiWebSocketUrl(`/cli-stream/${invocationId}`));
    setState('connecting');

    ws.onopen = () => {
      // server replays buffered chunks via XREAD from id 0 — nothing to send.
    };

    ws.onmessage = (ev) => {
      if (disposed) return;
      let parsed: { type: string; [k: string]: unknown } | null = null;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (!parsed) return;
      switch (parsed.type) {
        case 'connected':
          setState('connected');
          setErrorMsg(null);
          setSteerable(parsed.steerable === true);
          break;
        case 'output':
          if (typeof parsed.data === 'string') {
            // `text` frames carry the model's parsed prose for the Clean tab;
            // stdout/stderr (and legacy frames without a stream) go to xterm.
            if (parsed.stream === 'text') {
              if (parsed.data.length > 0) {
                const chunk = parsed.data;
                // Each `text` frame is one complete assistant turn / agent_message.
                // Separate consecutive responses with a blank line so they don't
                // visually run together — and so Markdown renders them as distinct
                // blocks rather than one continuous paragraph.
                setCleanText((prev) => {
                  if (!prev) return chunk;
                  const sep = prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
                  return prev + sep + chunk;
                });
              }
            } else {
              term.write(stripDel(parsed.data));
              if (parsed.data.length > 0) setHasOutput(true);
            }
          }
          break;
        case 'exit':
          setState('closed');
          setHasOutput(true);
          // The run ended — any steer that never reached a tool-call boundary was
          // never applied. Flip pending rows so they don't hang as "queued".
          setSteers((prev) =>
            prev.some((s) => s.status === 'sent')
              ? prev.map((s) => (s.status === 'sent' ? { ...s, status: 'unconsumed' } : s))
              : prev,
          );
          if (typeof parsed.code === 'number') {
            term.writeln(`\r\n\x1b[36m[CLI exited with code ${parsed.code}]\x1b[0m`);
            onExitRef.current?.(parsed.code);
          }
          break;
        case 'steer_consumed': {
          // The model drained this steer at a tool-call boundary — tick its row.
          const consumedId = typeof parsed.id === 'string' ? parsed.id : null;
          if (consumedId) {
            setSteers((prev) =>
              prev.map((s) =>
                s.id === consumedId && s.status === 'sent' ? { ...s, status: 'consumed' } : s,
              ),
            );
          }
          break;
        }
        case 'error':
          setState('error');
          setErrorMsg(typeof parsed.message === 'string' ? parsed.message : 'stream error');
          break;
      }
    };

    ws.onerror = () => {
      if (disposed) return;
      setState('error');
      setErrorMsg('websocket error');
    };

    ws.onclose = (ev) => {
      if (disposed) return;
      setState((prev) => (prev === 'error' ? prev : 'closed'));
      if (ev.code !== 1000) {
        term.writeln(
          `\r\n\x1b[31m[stream closed: ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}]\x1b[0m`,
        );
      }
    };

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      disposed = true;
      cancelAnimationFrame(fitRaf1);
      cancelAnimationFrame(fitRaf2);
      clearInterval(keepalive);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      detachWheel();
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // The component is re-mounted whenever invocationId changes, so the cleanup
    // tears down the old socket and a fresh one opens for the new invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invocationId, isReplay, staticOutput, staticExitCode]);

  // Re-fit xterm whenever the Raw panel becomes visible. While the Clean tab is
  // active the xterm container is display:none (zero size), so fit() must run
  // again on show or the grid stays collapsed.
  useEffect(() => {
    if (cleanSupported && tab !== 'raw') return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const t = termRef.current;
        if (t) t.refresh(0, t.rows - 1);
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(id);
  }, [tab, cleanSupported]);

  // CR-only sequences confuse HTML pre-wrap; JSON.parse already turned \n/\t into
  // real characters, so stripping bare \r is all the escaping the prose needs.
  const cleanContent = useMemo(
    () => (isReplay ? (staticCleanOutput ?? '') : cleanText).replace(/\r/g, ''),
    [isReplay, staticCleanOutput, cleanText],
  );

  // Keep the Clean panel pinned to the latest output as it streams — but only
  // while the user is at (or near) the bottom. Once they scroll up to read we
  // stop forcing them down; auto-scroll re-engages when they scroll back to the
  // bottom (handleCleanScroll re-arms cleanStickRef). The container remounts on a
  // tab switch, so a re-entry while still pinned lands on the newest output.
  useEffect(() => {
    const el = cleanScrollRef.current;
    if (el && cleanStickRef.current) el.scrollTop = el.scrollHeight;
  }, [cleanContent, tab]);

  // Re-arm the stick-to-bottom gate when the user is within the threshold of the
  // bottom, disarm it otherwise. Programmatic scrolls from the effect above land
  // at the bottom and so keep the gate armed (no feedback loop).
  const handleCleanScroll = () => {
    const el = cleanScrollRef.current;
    if (!el) return;
    cleanStickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= CLEAN_STICK_THRESHOLD_PX;
  };

  // Auto-switch to the Raw tab when a live run is clearly active (raw bytes flowing)
  // but the Clean tab is still empty after RAW_AUTOSWITCH_IDLE_MS — the model is
  // working yet has produced no parsed prose at all (common for Ollama-class models
  // that stream thinking frames into Raw). Skipped once the user has picked a tab
  // manually; a user click re-runs this effect (userPickedTab dep) and clears the
  // pending timer. Replay / no raw output / stream end never arm it.
  useEffect(() => {
    const cleanIsEmpty = cleanText.trim().length === 0;
    if (
      isReplay ||
      !cleanSupported ||
      state !== 'connected' ||
      !hasOutput ||
      !cleanIsEmpty ||
      userPickedTab
    ) {
      return;
    }
    const id = setTimeout(() => setTab('raw'), RAW_AUTOSWITCH_IDLE_MS);
    return () => clearTimeout(id);
  }, [isReplay, cleanSupported, state, hasOutput, cleanText, userPickedTab]);

  // Auto-return to Clean once prose lands, if we auto-switched to Raw and the user
  // hasn't taken manual control. Default tab is 'clean' and the only non-user path to
  // 'raw' is the auto-switch above, so `tab === 'raw' && !userPickedTab` uniquely means
  // "we imposed Raw" — safe to flip back without a separate flag.
  useEffect(() => {
    if (isReplay || userPickedTab) return;
    if (tab === 'raw' && cleanText.trim().length > 0) setTab('clean');
  }, [cleanText, tab, isReplay, userPickedTab]);

  const heightClass = height ?? (fill ? '' : 'h-[400px]');
  const showTabs = cleanSupported;
  const rawHidden = showTabs && tab !== 'raw';

  // Compact inline status driven by the most recent steer: shows the error or the
  // "queued" hint, and clears the moment that steer is consumed. The full per-steer
  // history lives behind the list popover.
  const latestSteer = steers.length > 0 ? steers[steers.length - 1]! : null;
  const steerInline =
    latestSteer?.status === 'error'
      ? { text: latestSteer.error ?? 'Steer failed', tone: 'error' as const }
      : latestSteer?.status === 'sent'
        ? { text: 'Steer queued — applies at the next tool call', tone: 'pending' as const }
        : null;

  return (
    <div className={`flex flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          {isReplay ? (
            <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
              replay
            </span>
          ) : (
            <StatusBadge state={state} />
          )}
          {errorMsg && <span className="text-red-400">{errorMsg}</span>}
          {cancelError && <span className="text-red-400">cancel: {cancelError}</span>}
          {steerInline && (
            <span className={steerInline.tone === 'error' ? 'text-red-400' : 'text-indigo-300'}>
              {steerInline.text}
            </span>
          )}
        </div>
        {!isReplay && (
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            {steerable && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendSteer();
                }}
                className="flex items-center gap-1"
              >
                <input
                  value={steerText}
                  onChange={(e) => setSteerText(e.target.value)}
                  placeholder="Steer the agent…"
                  disabled={steering || state !== 'connected'}
                  className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={steering || state !== 'connected' || steerText.trim().length === 0}
                  className="rounded border border-indigo-600 px-2 py-0.5 text-indigo-300 hover:bg-indigo-950 disabled:opacity-50"
                >
                  {steering ? 'Sending…' : 'Steer'}
                </button>
              </form>
            )}
            {steers.length > 0 && (
              <div className="relative" ref={steerListRef}>
                <button
                  type="button"
                  onClick={() => setSteerListOpen((v) => !v)}
                  className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
                  title="Sent steers"
                  aria-label={`Sent steers (${steers.length})`}
                  aria-expanded={steerListOpen}
                >
                  <SteerIcon />
                  <span className="tabular-nums">{steers.length}</span>
                </button>
                {steerListOpen && <SteerList steers={steers} />}
              </div>
            )}
            <span>Read-only — use Cancel to stop the running CLI</span>
            <button
              type="button"
              onClick={() => void cancelActiveCli()}
              disabled={cancelling || state !== 'connected'}
              className="rounded border border-red-700 px-2 py-0.5 text-red-300 hover:bg-red-950 disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel CLI'}
            </button>
          </div>
        )}
      </div>

      {showTabs && (
        <div className="flex items-center gap-1">
          <TabButton
            active={tab === 'clean'}
            onClick={() => {
              setUserPickedTab(true);
              setTab('clean');
            }}
          >
            Clean
          </TabButton>
          <TabButton
            active={tab === 'raw'}
            onClick={() => {
              setUserPickedTab(true);
              setTab('raw');
            }}
          >
            Raw
          </TabButton>
        </div>
      )}

      <div className={`w-full ${fill ? 'min-h-0 flex-1' : heightClass}`}>
        {/* Raw / xterm panel — always mounted so live frames are never lost;
            hidden (not unmounted) while the Clean tab is active. */}
        <div className={`relative h-full w-full ${rawHidden ? 'hidden' : ''}`}>
          <div
            ref={mountRef}
            className="h-full w-full rounded border border-neutral-800 bg-[#0a0a0a] p-2"
          />
          {!hasOutput && state !== 'error' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
              <span className="rounded bg-neutral-900/80 px-3 py-1">
                {state === 'connecting' ? 'Connecting…' : 'Waiting for CLI output…'}
              </span>
            </div>
          )}
        </div>
        {showTabs && tab === 'clean' && (
          <div
            ref={cleanScrollRef}
            onScroll={handleCleanScroll}
            className="h-full w-full overflow-auto rounded border border-neutral-800 bg-[#0a0a0a]"
          >
            {cleanContent.length === 0 ? (
              <div className="p-3 text-xs text-neutral-500">
                {isReplay
                  ? 'No model text for this run.'
                  : state === 'connecting'
                    ? 'Connecting…'
                    : 'No text generated by the model yet.'}
              </div>
            ) : (
              <CleanProse content={cleanContent} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type CleanSegment = { kind: 'normal' | 'think'; text: string; open: boolean };

// Split Clean-tab prose on <think>…</think> reasoning blocks. Some reasoning models
// (GLM/Ollama-class) inline their chain-of-thought as literal <think> tags in the
// assistant `text` channel; react-markdown escapes the tags, so they'd otherwise show
// verbatim. An unclosed <think> (the close tag hasn't streamed yet) makes everything
// after it a still-open think segment. Tag match is case-insensitive; non-nested.
function splitThink(content: string): CleanSegment[] {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  const lower = content.toLowerCase();
  const segs: CleanSegment[] = [];
  let i = 0;
  while (i < content.length) {
    const start = lower.indexOf(OPEN, i);
    if (start === -1) {
      segs.push({ kind: 'normal', text: content.slice(i), open: false });
      break;
    }
    if (start > i) segs.push({ kind: 'normal', text: content.slice(i, start), open: false });
    const afterOpen = start + OPEN.length;
    const end = lower.indexOf(CLOSE, afterOpen);
    if (end === -1) {
      segs.push({ kind: 'think', text: content.slice(afterOpen), open: true });
      break;
    }
    segs.push({ kind: 'think', text: content.slice(afterOpen, end), open: false });
    i = end + CLOSE.length;
  }
  return segs;
}

// Renders Clean-tab prose, folding <think> reasoning into collapsed disclosures.
// The outer scroll container owns padding/scroll; this just lays out the segments.
const CleanProse = memo(function CleanProse({ content }: { content: string }) {
  // splitThink scans the whole accumulated body; memoize on content so a steer-box
  // keystroke (re-renders the parent CliStreamViewer but does not change content)
  // skips both the scan and — via the memo wrapper — this entire subtree. During
  // live streaming content grows each frame, so only the changed tail segment's
  // MarkdownView (itself memoized on body) re-parses; finalized segments bail.
  const segments = useMemo(() => splitThink(content), [content]);
  return (
    <div className="p-3">
      {segments.map((seg, idx) =>
        seg.kind === 'think' ? (
          <ThinkBlock key={idx} text={seg.text} streaming={seg.open} />
        ) : (
          <NormalProse key={idx} text={seg.text} />
        ),
      )}
    </div>
  );
});

// One non-think prose segment. Markdown when it looks like it (react-markdown v10, no
// rehype-raw — escapes embedded HTML, strips javascript: URLs, safe for untrusted CLI
// output), otherwise pre-wrap. Raw text is preserved; trim is only the skip test so a
// no-think run renders identically to before.
function NormalProse({ text }: { text: string }) {
  if (!text.trim()) return null;
  return looksLikeMarkdown(text) ? (
    <MarkdownView body={text} enhanced={false} className="max-h-none overflow-visible" />
  ) : (
    <div className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-neutral-200">
      {text}
    </div>
  );
}

// A <think> block as a collapsed disclosure (native <details>, so expand state is
// DOM-owned and survives the constant streaming re-renders). Italic muted gray inside.
function ThinkBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const body = text.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!body.trim()) return null;
  return (
    <details className="my-2 rounded border border-neutral-800 bg-neutral-900/40">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300">
        Thinking{streaming ? '…' : ''}
      </summary>
      <div className="whitespace-pre-wrap break-words px-3 pb-2.5 pt-1 font-mono text-[12px] italic leading-relaxed text-neutral-500">
        {body}
      </div>
    </details>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] uppercase tracking-wider ${
        active
          ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
          : 'border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ state }: { state: ConnectionState }) {
  const color =
    state === 'connected'
      ? 'bg-green-500/20 text-green-300 border-green-500/40'
      : state === 'connecting'
        ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
        : state === 'error'
          ? 'bg-red-500/20 text-red-300 border-red-500/40'
          : 'bg-neutral-500/20 text-neutral-300 border-neutral-500/40';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${color}`}>
      {state}
    </span>
  );
}

// Small message-bubble glyph for the steer-list toggle (inline SVG, no icon dep).
function SteerIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// One-glyph status indicator for a steer-list row. Unicode symbols (not emoji).
function SteerStatusIcon({ status }: { status: SteerStatus }) {
  switch (status) {
    case 'consumed':
      return (
        <span className="mt-0.5 text-green-400" title="Applied at a tool-call boundary">
          ✓
        </span>
      );
    case 'sent':
      return (
        <span
          className="mt-0.5 animate-pulse text-amber-400"
          title="Queued — applies at the next tool call"
        >
          •
        </span>
      );
    case 'unconsumed':
      return (
        <span className="mt-0.5 text-neutral-500" title="The run ended before this was applied">
          —
        </span>
      );
    case 'error':
      return (
        <span
          className="mt-0.5 text-red-400"
          title="Rejected — the run had already finished its turn"
        >
          ✗
        </span>
      );
  }
}

// Popover listing the steers sent this session, newest last, each with its status
// glyph. Rendered inside the toggle's relative wrapper so an inside click (handled
// by the parent's click-outside effect) keeps it open.
function SteerList({ steers }: { steers: SteerEntry[] }) {
  return (
    <div className="absolute right-0 top-full z-20 mt-1 max-h-64 w-72 overflow-auto rounded border border-neutral-700 bg-neutral-900 p-2 shadow-lg">
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-neutral-500">Steers</div>
      <ul className="flex flex-col gap-1">
        {steers.map((s) => (
          <li key={s.id} className="flex items-start gap-2 px-1 py-0.5 text-xs">
            <SteerStatusIcon status={s.status} />
            <span className="min-w-0 flex-1 break-words text-neutral-200" title={s.error ?? s.text}>
              {s.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
