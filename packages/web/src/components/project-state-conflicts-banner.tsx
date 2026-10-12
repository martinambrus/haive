'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { Badge, Button } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';
import {
  PENDING_REFETCH_MS,
  RECORD_FILE,
  answerConfirmation,
  conflictKeyLabel,
  conflictSideMarkdown,
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
          <span className="text-neutral-300">
            This install and another one changed the same setting differently. Upgrades and
            rollbacks are held until every question is answered.
          </span>
        </div>
      )}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {conflicts.map((c) => {
        const message = messages[c.id];
        const busy = busyId === c.id;
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
              <p
                className={
                  message.tone === 'error' ? 'text-xs text-red-400' : 'text-xs text-amber-200'
                }
              >
                {message.text}
              </p>
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
  const [notice, setNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, ConflictMessage>>({});
  const [confirming, setConfirming] = useState<{
    conflict: ProjectStateConflictBody;
    answer: ProjectStateAnswer;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const alive = useRef(true);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ conflicts: ProjectStateConflictBody[] }>(
        `/repos/${repositoryId}/project-state/conflicts`,
      );
      if (!alive.current) return;
      setConflicts(res.conflicts);
      setLoadError(null);
    } catch (err) {
      if (alive.current) setLoadError((err as Error).message ?? 'Failed to check');
    }
  }, [repositoryId]);

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
    if (out.kind === 'resolved') {
      setNotice(
        answer === 'keep_mine'
          ? `Kept this install's value. Commit and push ${RECORD_FILE} so your teammate gets it.`
          : "This install now uses your teammate's value.",
      );
    }
    if (out.kind === 'pending') {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => void load(), PENDING_REFETCH_MS);
    } else {
      await load();
    }
  }

  if (loadError) {
    return <div className="text-xs text-red-400">Project record check: {loadError}</div>;
  }

  const confirmation = confirming
    ? answerConfirmation(confirming.answer, confirming.conflict.key)
    : null;

  return (
    <>
      <ProjectStateConflictsView
        conflicts={conflicts}
        notice={notice}
        messages={messages}
        busyId={busyId}
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
              <p className="text-sm text-neutral-300">{confirmation.body}</p>
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
