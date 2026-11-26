import type { stepRagStatsState } from '@/lib/step-banners';

export function StepRagStatsToggle({
  state,
  expanded,
  onToggle,
}: {
  state: ReturnType<typeof stepRagStatsState>;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (state === 'hidden') return null;
  if (state === 'unused') {
    return <span className="self-start text-xs text-neutral-400">No RAG used</span>;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="self-start text-xs text-indigo-400 underline"
    >
      {expanded ? 'Hide' : 'Show'} RAG stats
    </button>
  );
}
