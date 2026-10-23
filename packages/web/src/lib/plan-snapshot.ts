import type { PlanSnapshotHealth } from '@/lib/api-client';

/** Only git saying "no origin" (false) offers Link to origin; an unknown (null) shows the actions. */
export function showsPushAndPull(snapshot: PlanSnapshotHealth | null): boolean {
  return snapshot !== null && snapshot.hasOrigin !== false;
}

export type SnapshotTone = 'error' | 'good' | 'warn' | 'neutral';

export function snapshotStatus(snapshot: PlanSnapshotHealth | null): {
  label: string;
  tone: SnapshotTone;
} {
  const tone: SnapshotTone = snapshot?.lastError ? 'error' : snapshot?.committed ? 'good' : 'warn';
  if (!snapshot) return { label: 'Checking snapshot…', tone };
  if (snapshot.lastError) return { label: 'Snapshot error', tone };
  if (snapshot.snapshotState === 'missing') return { label: 'Snapshot missing', tone };
  if (!snapshot.snapshotWritten) return { label: 'Snapshot updating…', tone };
  if (!snapshot.committed) {
    if (snapshot.tracked === false || snapshot.uncommitted === true) {
      return { label: 'Not committed', tone };
    }
    return { label: 'Commit state unknown', tone: 'neutral' };
  }
  if (snapshot.pushed === true) return { label: 'Committed and pushed', tone };
  if (snapshot.pushed === false) return { label: 'Committed, not pushed', tone };
  return { label: 'Committed', tone };
}
