'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  TYPE_DRAFT_MESSAGE_MAX_CHARS,
  TYPE_DRAFT_STATE_MAX_BYTES,
  type TypeDraftTurn,
} from '@haive/shared/modularity';
import {
  endTypeDraft,
  getTypeDraft,
  startTypeDraft,
  submitTypeDraftTurn,
  type ApiError,
  type TypeDraftConversation,
} from '@/lib/api-client';
import { Button, Card, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

const POLL_MS = 2000;
const ENDED = ['completed', 'failed', 'cancelled'];
const IGNORED = {
  'too-large': 'Your editor state was not sent: it was too large.',
  'not-json': 'Your editor state was not sent: it was not valid JSON.',
};

export const draftStorageKey = (slug: string | null): string =>
  `haive:task-type-draft:${slug ?? 'new'}`;

function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, taskId: string | null): void {
  try {
    if (taskId === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, taskId);
  } catch {
    // Without storage the conversation is just not resumed.
  }
}

/** Stops the page from resuming the conversation; the task itself stays in the task list. */
export const forgetDraftConversation = (slug: string | null): void =>
  remember(draftStorageKey(slug), null);

const errorText = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

function issueText(issue: unknown): string {
  if (typeof issue !== 'object' || issue === null) return String(issue);
  const { path, stepId, message, kind } = issue as Record<string, unknown>;
  const where =
    typeof path === 'string' && path !== '' ? path : typeof stepId === 'string' ? stepId : '';
  const what =
    typeof message === 'string'
      ? message
      : typeof kind === 'string'
        ? kind.replaceAll('-', ' ')
        : JSON.stringify(issue);
  return where === '' ? what : `${where}: ${what}`;
}

function problems(title: string, items: readonly string[]): ReactNode {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-amber-300">{title}</p>
      <ul className="ml-4 list-disc text-xs text-neutral-300 [overflow-wrap:anywhere]">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function turnView(
  turn: TypeDraftTurn,
  index: number,
  load: (() => void) | null,
  loaded: boolean,
): ReactNode {
  return (
    <div
      key={index}
      className="flex flex-col gap-1 border-t border-neutral-800 pt-2 first:border-t-0 first:pt-0"
    >
      <p className="text-[11px] uppercase tracking-wide text-indigo-300">
        {turn.role === 'user' ? 'You' : 'Agent'}
      </p>
      <MarkdownView body={turn.body} className="max-h-none overflow-visible px-0 py-1" />
      {turn.role === 'user' && turn.draftIgnored && (
        <p className="text-xs text-amber-300">{IGNORED[turn.draftIgnored]}</p>
      )}
      {turn.role === 'assistant' && (
        <>
          {problems('Problems with this draft', turn.issues.map(issueText))}
          {problems('Warnings', turn.warnings.map(issueText))}
          {problems('Left out, because the editor cannot show it', turn.dropped.map(String))}
          {turn.error && (
            <p className="text-xs text-red-300">{`The reply could not be read (${turn.error}).`}</p>
          )}
          {turn.repaired && (
            <p className="text-xs text-neutral-400">
              Haive asked the agent to correct this draft once.
            </p>
          )}
        </>
      )}
      {load && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={load}>
            Load into editor
          </Button>
          {loaded && (
            <span className="text-xs text-emerald-400">
              Loaded into the form below. Nothing is saved until you press Save.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskTypeCreatorPanel({
  slug,
  editorState,
  onLoad,
}: {
  /** The saved type being edited; null on the create page. */
  slug: string | null;
  /** The editor as it stands, in the shape the agent reads. */
  editorState: Record<string, unknown>;
  /** Puts a draft into the editor as unsaved changes. */
  onLoad: (draft: Record<string, unknown>) => void;
}) {
  const key = draftStorageKey(slug);
  const [taskId, setTaskId] = useState<string | null>(() => remembered(key));
  const [conversation, setConversation] = useState<TypeDraftConversation | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollRestart, setPollRestart] = useState(0);
  const [loadedTurn, setLoadedTurn] = useState<number | null>(null);
  const [stateLeftOut, setStateLeftOut] = useState(false);
  const transcript = useRef<HTMLDivElement | null>(null);
  // A conversation already over when this visit finds it starts afresh; one that ends in view stays readable.
  const seen = useRef(false);

  useEffect(() => {
    if (taskId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const next = await getTypeDraft(taskId);
        if (cancelled) return;
        setError(null);
        if (ENDED.includes(next.status)) {
          remember(key, null);
          setTaskId(null);
          if (seen.current) {
            setConversation(next);
            setEnded(next.status);
          }
          return;
        }
        seen.current = true;
        setConversation(next);
        if (next.awaitingMessage) return;
      } catch (err) {
        if (cancelled) return;
        if ((err as ApiError).status === 404) {
          remember(key, null);
          setTaskId(null);
          return;
        }
        setError(errorText(err, 'The conversation could not be read'));
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, pollRestart, key]);

  const turnCount = conversation?.turns.length ?? 0;
  useEffect(() => {
    const box = transcript.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turnCount]);

  async function start(): Promise<void> {
    const text = message.trim();
    if (!text) return;
    // The api refuses a start whose state is over its limit; a follow-up's is dropped with a note instead.
    const fits =
      new TextEncoder().encode(JSON.stringify(editorState)).length <= TYPE_DRAFT_STATE_MAX_BYTES;
    setBusy(true);
    setError(null);
    try {
      const started = await startTypeDraft({
        message: text,
        ...(fits ? { current: editorState } : {}),
        ...(slug === null ? {} : { editingSlug: slug }),
      });
      remember(key, started.taskId);
      seen.current = true;
      setConversation(null);
      setLoadedTurn(null);
      setEnded(null);
      setStateLeftOut(!fits);
      setMessage('');
      setTaskId(started.taskId);
    } catch (err) {
      setError(errorText(err, 'Failed to start the conversation'));
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    const text = message.trim();
    if (!text || taskId === null) return;
    setBusy(true);
    setError(null);
    try {
      await submitTypeDraftTurn(taskId, text, JSON.stringify(editorState));
      setMessage('');
      setConversation((held) => (held ? { ...held, awaitingMessage: false } : held));
      setPollRestart((n) => n + 1);
    } catch (err) {
      setError(errorText(err, 'Failed to send the message'));
    } finally {
      setBusy(false);
    }
  }

  async function end(): Promise<void> {
    if (taskId === null) return;
    setBusy(true);
    setError(null);
    try {
      await endTypeDraft(taskId);
      remember(key, null);
      setTaskId(null);
    } catch (err) {
      setError(errorText(err, 'Failed to end the conversation'));
    } finally {
      setBusy(false);
    }
  }

  const live = taskId !== null;
  const awaiting = live && conversation?.awaitingMessage === true;
  const loadAt = conversation
    ? conversation.turns.findLastIndex((turn) => turn.role === 'assistant' && turn.draft !== null)
    : -1;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h3 className="text-sm font-semibold text-neutral-200">Draft with an agent</h3>
        <p className="mt-1 text-xs text-neutral-400">
          Describe the task type you want. The agent&apos;s draft is loaded into the form below as
          unsaved changes; nothing is saved until you press Save.
        </p>
      </div>
      {conversation && conversation.turns.length > 0 && (
        <div
          ref={transcript}
          role="log"
          aria-live="polite"
          className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto"
        >
          {conversation.turns.map((turn, i) => {
            const draft = turn.role === 'assistant' ? turn.draft : null;
            const load =
              i === loadAt && draft
                ? () => {
                    onLoad(draft);
                    setLoadedTurn(i);
                  }
                : null;
            return turnView(turn, i, load, loadedTurn === i);
          })}
        </div>
      )}
      {stateLeftOut && <p className="text-xs text-amber-300">{IGNORED['too-large']}</p>}
      {live && !awaiting && (
        <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {conversation === null ? 'Loading the conversation…' : 'The agent is working…'}
        </div>
      )}
      {ended && (
        <p className="text-xs text-amber-300">
          {`The conversation has ended (${ended}). Send a message to start another.`}
        </p>
      )}
      <FormError message={error} />
      {(!live || awaiting) && (
        <>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={TYPE_DRAFT_MESSAGE_MAX_CHARS}
            disabled={busy}
            aria-label={live ? 'Your next message to the agent' : 'What the agent should draft'}
            placeholder={
              live
                ? 'Ask for a change'
                : 'e.g. a read-only audit that lists the TODO comments and rates how urgent each is'
            }
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !message.trim()}
              onClick={() => void (live ? send() : start())}
            >
              {busy ? 'Sending…' : 'Send'}
            </Button>
            {live && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void end()}>
                End conversation
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
