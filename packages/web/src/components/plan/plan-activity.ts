'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type PlanActivityReporter = (id: symbol, pending: boolean) => void;

/** One registry per page visit; each mounted producer owns its own entry. */
export function usePlanActivityRegistry() {
  const [reporters, setReporters] = useState<ReadonlySet<symbol>>(() => new Set());
  const [contentKey, setContentKey] = useState(0);
  const report = useCallback<PlanActivityReporter>((id, pending) => {
    setReporters((previous) => {
      if (previous.has(id) === pending) return previous;
      const next = new Set(previous);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const answered = useCallback(() => setContentKey((key) => key + 1), []);
  return { pending: reporters.size > 0, contentKey, report, answered };
}

/** Optional because the same chat also appears on the task page. */
export function usePlanPending(report: PlanActivityReporter | undefined, pending: boolean) {
  const id = useRef(Symbol('plan activity')).current;
  useEffect(() => {
    report?.(id, pending);
  }, [report, id, pending]);
  useEffect(() => () => report?.(id, false), [report, id]);
}

/** Loading history is a baseline. Only a later assistant turn is new content. */
export function usePlanAnswer(onAnswer: (() => void) | undefined) {
  const previous = useRef<{ scope: string; answer: string | null } | null>(null);
  const callback = useRef(onAnswer);
  callback.current = onAnswer;
  return useCallback((scope: string, answer: string | null) => {
    const before = previous.current;
    previous.current = { scope, answer };
    if (before?.scope === scope && answer !== null && answer !== before.answer) {
      callback.current?.();
    }
  }, []);
}
