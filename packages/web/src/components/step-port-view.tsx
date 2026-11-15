'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';
import type { StepPortProjection } from '@haive/shared/step-ports';
import { api } from '@/lib/api-client';
import { Button, FormError } from '@/components/ui';

const StepPortCanvas = dynamic(() => import('./step-port-canvas'), {
  ssr: false,
  loading: () => <p className="text-sm text-neutral-400">Loading canvas…</p>,
});
export interface StepPortViewProps {
  children: ReactNode;
  request: { path: string; body?: unknown; revision?: string };
  executionPath?: string | null;
  disabled?: boolean;
  /** Task cards remain actionable alongside the history graph. */
  keepListVisible?: boolean;
  hasSteps?: boolean;
  onCanvasChange?: (canvas: boolean) => void;
  onReorder?: (from: number, to: number) => void;
}

/** The list and canvas share one serialized draft. Responses are view data, never editor state. */
export function StepPortView({
  children,
  request,
  executionPath,
  disabled = false,
  keepListVisible = false,
  hasSteps = true,
  onReorder,
  onCanvasChange,
}: StepPortViewProps) {
  const [canvas, setCanvas] = useState(false);
  const [result, setResult] = useState<{ key: string; data: StepPortProjection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(request);
  useEffect(() => {
    if (!canvas || !hasSteps) return;
    const controller = new AbortController();
    setError(null);
    const current = JSON.parse(key) as StepPortViewProps['request'];
    const pending =
      current.body === undefined
        ? api.get<StepPortProjection>(current.path, controller.signal)
        : api.post<StepPortProjection>(current.path, current.body, controller.signal);
    void pending
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load ports');
      });
    return () => controller.abort();
  }, [canvas, key, hasSteps]);
  const candidates = result?.key === key ? result.data.candidates : [];
  const loaded = result?.key === key;
  const graph = candidates.find(
    (candidate) => candidate.executionPath === (executionPath ?? null),
  )?.graph;
  // Keep the existing flow mounted during a refresh so an accepted reorder retains
  // its viewport. Hide stale data until the matching response arrives.
  const retainedGraph = result?.data.candidates.find(
    (candidate) => candidate.executionPath === (executionPath ?? null),
  )?.graph;
  if (!hasSteps) return <>{children}</>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-2" role="group" aria-label="Step view">
        <Button
          type="button"
          variant={canvas ? 'secondary' : 'primary'}
          disabled={disabled}
          aria-pressed={!canvas}
          onClick={() => {
            setCanvas(false);
            onCanvasChange?.(false);
          }}
        >
          List
        </Button>
        <Button
          type="button"
          variant={canvas ? 'primary' : 'secondary'}
          disabled={disabled}
          aria-pressed={canvas}
          onClick={() => {
            setCanvas(true);
            onCanvasChange?.(true);
          }}
        >
          Canvas
        </Button>
      </div>
      {canvas && (
        <>
          {error && <FormError message={error} />}
          {!error && !graph && (
            <p role="status" className="text-sm text-neutral-400">
              {loaded ? 'No port graph is available for the selected path.' : 'Loading ports…'}
            </p>
          )}
          {loaded && result.data.candidatesOnly && (
            <p role="status" className="text-sm text-neutral-400">
              Path not selected. Candidate ports only; bindings are not pinned.
            </p>
          )}
          {retainedGraph && (
            <div hidden={!graph}>
              <StepPortCanvas
                graph={graph ?? retainedGraph}
                compact={keepListVisible}
                onReorder={disabled || !graph ? undefined : onReorder}
              />
            </div>
          )}
        </>
      )}
      {(!canvas || keepListVisible) && children}
    </div>
  );
}
