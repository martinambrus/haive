'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { Badge, Button } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import {
  PENDING_GAVE_UP_MESSAGE,
  PENDING_REFETCH_LIMIT,
  PENDING_REFETCH_MS,
  answerConfirmation,
  resolutionNotice,
  conflictKeyLabel,
  conflictSideMarkdown,
  stillListed,
  submitConflictAnswer,
  type ProjectStateAnswer,
  type ProjectStateConflictBody,
} from '@/lib/project-state-conflicts';

export interface ConflictMessage {
  tone: 'error' | 'info';
  text: string;
}

export interface ProjectStateConflictsViewProps {
  conflicts: ProjectStateConflictBody[];
  notice: string | null;
  messages: Record<string, ConflictMessage>;
  busyId: string | null;
  pendingIds: readonly string[];
  onAnswer: (conflict: ProjectStateConflictBody, answer: ProjectStateAnswer) => void;
}

function Side({ title, markdown }: { title: string; markdown: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-neutral-400">{title}</p>
      <MarkdownView body={markdown} enhanced={false} />
    </div>
  );
}

export function ProjectStateConflictsView({
  conflicts,
  notice,
  messages,
  busyId,
  pendingIds,
  onAnswer,
}: ProjectStateConflictsViewProps) {
  if (conflicts.length === 0 && !notice) return null;
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm">
      {conflicts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">
            {conflicts.length === 1 ? 'Question' : `${conflicts.length} questions`} about the
            project record
          </Badge>
          <InlineMarkdown
            className="text-neutral-300"
            body="This install and another one changed the same setting differently. Upgrades and rollbacks are held until every question is answered."
          />
        </div>
      )}
      {notice && <InlineMarkdown body={notice} className="text-xs text-emerald-400" />}
      {conflicts.map((c) => {
        const message = messages[c.id];
        const busy = busyId === c.id || pendingIds.includes(c.id);
        return (
          <div
            key={c.id}
            className="flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
          >
            <p className="text-sm font-semibold text-neutral-100">{conflictKeyLabel(c.key)}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Side title="This install" markdown={conflictSideMarkdown(c.local)} />
              <Side title="The other install" markdown={conflictSideMarkdown(c.incoming)} />
              <Side title="Before either changed it" markdown={conflictSideMarkdown(c.base)} />
            </div>
            {message && (
              <InlineMarkdown
                className={
                  message.tone === 'error' ? 'text-xs text-red-400' : 'text-xs text-amber-200'
                }
                body={message.text}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => onAnswer(c, 'keep_mine')}
                disabled={busy || !c.local.present}
              >
                Keep mine
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onAnswer(c, 'take_theirs')}
                disabled={busy}
              >
                Take theirs
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface ProjectStateConflictsBannerProps {
  repositoryId: string;
}

export function ProjectStateConflictsBanner({ repositoryId }: ProjectStateConflictsBannerProps) {
  const [conflicts, setConflicts] = useState<ProjectStateConflictBody[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ProjectStateAnswer[]>([]);
  const [messages, setMessages] = useState<Record<string, ConflictMessage>>({});
  const [confirming, setConfirming] = useState<{
    conflict: ProjectStateConflictBody;
    answer: ProjectStateAnswer;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const pendingAnswers = useRef<Record<string, ProjectStateAnswer>>({});
  const refetchCount = useRef(0);
  const alive = useRef(true);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (quiet = false): Promise<ProjectStateConflictBody[] | null> => {
      try {
        const res = await api.get<{ conflicts: ProjectStateConflictBody[] }>(
          `/repos/${repositoryId}/project-state/conflicts`,
        );
        if (!alive.current) return null;
        setConflicts(res.conflicts);
        setLoadError(null);
        return res.conflicts;
      } catch (err) {
        if (alive.current && !quiet) setLoadError((err as Error).message ?? 'Failed to check');
        return null;
      }
    },
    [repositoryId],
  );

  const setPending = useCallback((ids: string[]) => {
    pendingRef.current = ids;
    setPendingIds(ids);
  }, []);

  const pollPending = useCallback(async () => {
    refetchTimer.current = null;
    const listed = await load(true);
    if (!alive.current) return;
    const remaining =
      listed === null ? pendingRef.current : stillListed(pendingRef.current, listed);
    const done = pendingRef.current.filter((id) => !remaining.includes(id));
    if (done.length > 0) {
      setAnswered((prev) => [...prev, ...done.map((id) => pendingAnswers.current[id]!)]);
      for (const id of done) delete pendingAnswers.current[id];
    }
    setPending(remaining);
    if (remaining.length === 0) return;
    refetchCount.current += 1;
    if (refetchCount.current < PENDING_REFETCH_LIMIT) {
      refetchTimer.current = setTimeout(() => void pollPending(), PENDING_REFETCH_MS);
      return;
    }
    setMessages((prev) => {
      const next = { ...prev };
      for (const id of remaining) next[id] = { tone: 'info', text: PENDING_GAVE_UP_MESSAGE };
      return next;
    });
  }, [load, setPending]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [load]);

  async function confirm() {
    if (!confirming || busyId) return;
    const { conflict, answer } = confirming;
    setBusyId(conflict.id);
    const out = await submitConflictAnswer(api.post, repositoryId, conflict.id, answer);
    if (!alive.current) return;
    setBusyId(null);
    setConfirming(null);
    setMessages((prev) => {
      const next = { ...prev };
      delete next[conflict.id];
      if (out.kind === 'pending') next[conflict.id] = { tone: 'info', text: out.message };
      if (out.kind === 'error') next[conflict.id] = { tone: 'error', text: out.message };
      return next;
    });
    if (out.kind === 'resolved') setAnswered((prev) => [...prev, answer]);
    if (out.kind === 'pending') {
      pendingAnswers.current[conflict.id] = answer;
      setPending([...pendingRef.current.filter((id) => id !== conflict.id), conflict.id]);
      refetchCount.current = 0;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => void pollPending(), PENDING_REFETCH_MS);
    } else {
      await load();
    }
  }

  if (loadError) {
    return (
      <InlineMarkdown
        className="text-xs text-red-400"
        body={`Project record check: ${loadError}`}
      />
    );
  }

  const confirmation = confirming
    ? answerConfirmation(confirming.answer, confirming.conflict.key)
    : null;

  return (
    <>
      <ProjectStateConflictsView
        conflicts={conflicts}
        notice={resolutionNotice(answered)}
        messages={messages}
        busyId={busyId}
        pendingIds={pendingIds}
        onAnswer={(conflict, answer) => setConfirming({ conflict, answer })}
      />
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busyId && setConfirming(null)}
      >
        <DialogContent>
          {confirmation && (
            <>
              <DialogHeader>
                <h2 className="text-sm font-semibold text-neutral-100">{confirmation.title}</h2>
              </DialogHeader>
              <InlineMarkdown body={confirmation.body} className="text-sm text-neutral-300" />
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(null)}
                  disabled={busyId !== null}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void confirm()} disabled={busyId !== null}>
                  {busyId ? 'Sending...' : confirmation.confirmLabel}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
