'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { blocksUpgrade } from '@haive/shared/project-state-conflicts';
import { Badge, Button } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import {
  PENDING_GAVE_UP_MESSAGE,
  PENDING_REFETCH_LIMIT,
  PENDING_REFETCH_MS,
  answerConfirmation,
  landedAnswer,
  resolutionNotice,
  conflictClaimPath,
  conflictKeyLabel,
  conflictSideMarkdown,
  isClaimConflict,
  isPlanConflict,
  isRtkConflict,
  planConflictHeading,
  isSettingConflict,
  stillListed,
  answerAndConfirm,
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
  /** `plan` shows the questions about plan nodes; `project` (the default) every other one. */
  scope?: ConflictScope;
}

export type ConflictScope = 'project' | 'plan';

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
  scope = 'project',
}: ProjectStateConflictsViewProps) {
  if (conflicts.length === 0 && !notice) return null;
  const plan = scope === 'plan';
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm">
      {conflicts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">
            {conflicts.length === 1 ? 'Question' : `${conflicts.length} questions`} about the{' '}
            {plan ? 'plan' : 'project record'}
          </Badge>
          <InlineMarkdown
            className="text-neutral-300"
            body={
              plan
                ? "This install and another one changed the same part of the plan differently. This install's value stays in effect until you answer, and upgrades are not held."
                : conflicts.some((c) => blocksUpgrade(c.unit))
                  ? 'This install and another one changed the same setting differently. Upgrades and rollbacks are held until every question is answered.'
                  : "This install and another one changed the same setting differently. This install's value stays in effect and upgrades are not held."
            }
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
            {isPlanConflict(c) ? (
              <InlineMarkdown
                className="text-sm font-semibold text-neutral-100"
                body={planConflictHeading(c)}
              />
            ) : (
              <p className="text-sm font-semibold text-neutral-100">
                {conflictKeyLabel(c.key, c.unit, conflictClaimPath(c))}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Side title="This install" markdown={conflictSideMarkdown(c.local, c.unit)} />
              <Side title="The other install" markdown={conflictSideMarkdown(c.incoming, c.unit)} />
              <Side
                title="Before either changed it"
                markdown={conflictSideMarkdown(c.base, c.unit)}
              />
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

type AnsweredConflict = Pick<ProjectStateConflictBody, 'unit' | 'base' | 'local'> & {
  answer: ProjectStateAnswer;
};

export interface ProjectStateConflictsBannerProps {
  repositoryId: string;
  scope?: ConflictScope;
  /** Called once an answer has landed, for a page that shows what the answer changed. */
  onAnswered?: () => void;
  /** Re-reads the questions this often, for a page where background work can ask new ones. */
  pollMs?: number;
}

export function ProjectStateConflictsBanner({
  repositoryId,
  scope = 'project',
  onAnswered,
  pollMs,
}: ProjectStateConflictsBannerProps) {
  const [conflicts, setConflicts] = useState<ProjectStateConflictBody[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ProjectStateAnswer[]>([]);
  const [rtkAnswered, setRtkAnswered] = useState<ProjectStateAnswer[]>([]);
  const [claimAnswered, setClaimAnswered] = useState<ProjectStateAnswer[]>([]);
  const [settingAnswered, setSettingAnswered] = useState<ProjectStateAnswer[]>([]);
  const [planAnswered, setPlanAnswered] = useState<ProjectStateAnswer[]>([]);
  const [messages, setMessages] = useState<Record<string, ConflictMessage>>({});
  const [confirming, setConfirming] = useState<{
    conflict: ProjectStateConflictBody;
    answer: ProjectStateAnswer;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const onAnsweredRef = useRef(onAnswered);
  onAnsweredRef.current = onAnswered;
  const pendingAnswers = useRef<Record<string, ProjectStateAnswer>>({});
  const recordAnswers = useCallback((items: AnsweredConflict[]) => {
    const plan = items.filter(isPlanConflict).map((i) => i.answer);
    const rtk = items.filter(isRtkConflict).map((i) => i.answer);
    const claims = items.filter(isClaimConflict).map((i) => i.answer);
    const settings = items.filter(isSettingConflict).map((i) => i.answer);
    const rest = items
      .filter(
        (i) =>
          !isPlanConflict(i) && !isRtkConflict(i) && !isClaimConflict(i) && !isSettingConflict(i),
      )
      .map((i) => i.answer);
    if (plan.length > 0) setPlanAnswered((prev) => [...prev, ...plan]);
    if (rest.length > 0) setAnswered((prev) => [...prev, ...rest]);
    if (settings.length > 0) setSettingAnswered((prev) => [...prev, ...settings]);
    if (rtk.length > 0) setRtkAnswered((prev) => [...prev, ...rtk]);
    if (claims.length > 0) setClaimAnswered((prev) => [...prev, ...claims]);
  }, []);
  const refetchCount = useRef(0);
  const pollLoop = useRef(false);
  const alive = useRef(true);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (quiet = false): Promise<ProjectStateConflictBody[] | null> => {
      try {
        const res = await api.get<{ conflicts: ProjectStateConflictBody[] }>(
          `/repos/${repositoryId}/project-state/conflicts`,
        );
        if (!alive.current) return null;
        const mine = res.conflicts.filter((c) => isPlanConflict(c) === (scope === 'plan'));
        setConflicts(mine);
        setLoadError(null);
        return mine;
      } catch (err) {
        if (alive.current && !quiet) setLoadError((err as Error).message ?? 'Failed to check');
        return null;
      }
    },
    [repositoryId, scope],
  );

  const setPending = useCallback((ids: string[]) => {
    pendingRef.current = ids;
    setPendingIds(ids);
  }, []);

  const pollPending = useCallback(async () => {
    refetchTimer.current = null;
    const before = [...pendingRef.current];
    const listed = await load(true);
    if (!alive.current) return;
    const remaining = listed === null ? [...before] : stillListed(before, listed);
    const done = before.filter((id) => !remaining.includes(id));
    const unconfirmed: string[] = [];
    if (done.length > 0) {
      const looked = await Promise.all(
        done.map((id) =>
          api
            .get<{ conflict: ProjectStateConflictBody }>(
              `/repos/${repositoryId}/project-state/conflicts/${id}`,
            )
            .then((res) => ({
              id,
              ok: true,
              answer: landedAnswer(res.conflict.resolution),
              conflict: res.conflict,
            }))
            .catch(() => ({ id, ok: false, answer: null, conflict: null })),
        ),
      );
      if (!alive.current) return;
      const answers: AnsweredConflict[] = [];
      for (const l of looked) {
        if (!l.ok) {
          unconfirmed.push(l.id);
          continue;
        }
        delete pendingAnswers.current[l.id];
        if (l.answer && l.conflict) answers.push({ answer: l.answer, ...l.conflict });
      }
      recordAnswers(answers);
      if (answers.length > 0) onAnsweredRef.current?.();
    }
    remaining.push(...unconfirmed);
    remaining.push(...pendingRef.current.filter((id) => !before.includes(id)));
    setPending(remaining);
    if (remaining.length === 0) {
      pollLoop.current = false;
      return;
    }
    refetchCount.current += 1;
    if (refetchCount.current < PENDING_REFETCH_LIMIT) {
      refetchTimer.current = setTimeout(() => void pollPending(), PENDING_REFETCH_MS);
      return;
    }
    pollLoop.current = false;
    setMessages((prev) => {
      const next = { ...prev };
      for (const id of remaining) next[id] = { tone: 'info', text: PENDING_GAVE_UP_MESSAGE };
      return next;
    });
  }, [load, setPending, recordAnswers, repositoryId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
      pollLoop.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (!pollLoop.current) void load(true);
    }, pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  async function confirm() {
    if (!confirming || busyId) return;
    const { conflict, answer } = confirming;
    setBusyId(conflict.id);
    const out = await answerAndConfirm(api.post, api.get, repositoryId, conflict.id, answer);
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
    if (out.kind === 'resolved') recordAnswers([{ answer, ...conflict }]);
    if (out.kind === 'error' && out.landed) {
      recordAnswers([{ answer: out.landed, ...conflict }]);
    }
    if (out.kind === 'pending') {
      pendingAnswers.current[conflict.id] = answer;
      setPending([...pendingRef.current.filter((id) => id !== conflict.id), conflict.id]);
      refetchCount.current = 0;
      if (!pollLoop.current) {
        pollLoop.current = true;
        refetchTimer.current = setTimeout(() => void pollPending(), PENDING_REFETCH_MS);
      }
    } else {
      await load();
    }
    if (out.kind === 'resolved' || (out.kind === 'error' && out.landed)) onAnsweredRef.current?.();
  }

  const confirmation = confirming
    ? answerConfirmation(
        confirming.answer,
        confirming.conflict.key,
        confirming.conflict.unit,
        conflictClaimPath(confirming.conflict),
        isRtkConflict(confirming.conflict),
      )
    : null;

  return (
    <>
      {loadError && (
        <InlineMarkdown
          className="text-xs text-red-400"
          body={`Project record check: ${loadError}`}
        />
      )}
      <ProjectStateConflictsView
        conflicts={conflicts}
        notice={resolutionNotice(
          answered,
          rtkAnswered,
          claimAnswered,
          settingAnswered,
          planAnswered,
        )}
        scope={scope}
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
