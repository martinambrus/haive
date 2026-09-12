import type { StoredCleanTranscript } from '@/lib/api-client';
import type { RestoredSteer } from '@/lib/steer-history';

/** A steer's lifecycle in the viewer. `sent` = accepted by the API (queued to the CLI's
 *  stdin); `consumed` = drained by the model at a tool-call boundary (the worker's
 *  `steer_consumed` frame); `unconsumed` = the run ended before it drained; `error` = the API
 *  rejected it (e.g. the turn already finished).
 *
 *  `historical` = restored from `steering.nudge` task events on a legacy replay, where only
 *  the SEND was ever recorded. It claims no outcome rather than reporting a `sent` that may
 *  long since have been consumed — the same rule the step banners follow about copy that
 *  outlives its state. */
export type SteerStatus = 'sent' | 'consumed' | 'unconsumed' | 'error' | 'historical';

/** One turn of the Clean tab.
 *
 *  `history` is the legacy-replay case only: an invocation that ran before the transcript was
 *  persisted knows WHICH steers it was given but not where they landed, so they are grouped
 *  rather than interleaved. Inventing a position would be worse than admitting there is none.
 *
 *  Distinct from `CleanSegment` in CliStreamViewer, which is `splitThink`'s `normal | think`
 *  output — a different layer, applied WITHIN one model turn. */
export type TranscriptSegment =
  | { kind: 'model'; text: string }
  | { kind: 'user'; id: string; text: string; status: SteerStatus; error?: string }
  | { kind: 'history'; steers: readonly RestoredSteer[] };

/** Append one model-prose frame.
 *
 *  Coalesces into a trailing `model` segment, so a turn that arrives as forty deltas is ONE
 *  body for the markdown renderer rather than forty fragments. A user turn is the only thing
 *  that breaks the run — which is the whole point: the prose under a steer is the reply to it.
 *
 *  `\r` is stripped HERE rather than at render time. That is not cosmetic: doing it once per
 *  chunk instead of once per render over the whole accumulated body is what lets the segment
 *  array stay referentially stable, and the memoized subtree below depends on that. */
export function appendModelText(
  segments: readonly TranscriptSegment[],
  chunk: string,
): TranscriptSegment[] {
  const text = chunk.replace(/\r/g, '');
  if (!text) return segments as TranscriptSegment[];
  const last = segments[segments.length - 1];
  if (last?.kind === 'model') {
    const sep = last.text.endsWith('\n\n') ? '' : last.text.endsWith('\n') ? '\n' : '\n\n';
    return [...segments.slice(0, -1), { kind: 'model', text: last.text + sep + text }];
  }
  return [...segments, { kind: 'model', text }];
}

/** Append the turn the sender just submitted, optimistically — before any frame confirms it,
 *  so pressing Enter puts your words in the transcript immediately.
 *
 *  Idempotent on a non-empty id, because the optimistic append LOSES A RACE often enough to
 *  matter: the POST resolves only after a round trip, while the worker publishes the `steer`
 *  frame the moment the text reaches the CLI's stdin, so the frame frequently arrives first
 *  and `applySteerFrame` has already added the turn. MEASURED in the browser against a live
 *  plan-chat run — one steer rendered as two identical `You ✓` turns while the persisted
 *  transcript held exactly one. Guarding only the frame side leaves the race open from the
 *  other direction.
 *
 *  The failure path is unaffected: a POST that threw published no frame, so there is no id to
 *  collide with and the `error` turn appends normally. */
export function appendUserTurn(
  segments: readonly TranscriptSegment[],
  turn: { id: string; text: string; status: SteerStatus; error?: string },
): TranscriptSegment[] {
  if (turn.id && segments.some((s) => s.kind === 'user' && s.id === turn.id)) {
    return segments as TranscriptSegment[];
  }
  return [...segments, { kind: 'user', ...turn }];
}

/** Reconcile a `steer` frame from the server.
 *
 *  UPSERT, never a plain append. Two things make that mandatory: the sender already added
 *  this turn optimistically, and the API replays the whole Redis stream from id 0 to every
 *  viewer that opens the terminal — so an append would render every steer twice for the
 *  person who sent it, and again on each reconnect. A turn already marked `consumed` keeps
 *  that status: the replayed frame is older news than the tick it already got. */
export function applySteerFrame(
  segments: readonly TranscriptSegment[],
  frame: { id: string; text: string },
): TranscriptSegment[] {
  if (frame.id) {
    const at = segments.findIndex((s) => s.kind === 'user' && s.id === frame.id);
    if (at !== -1) return segments as TranscriptSegment[];
  }
  // An id-less steer (a legacy bare-string channel payload) cannot be correlated, so it is
  // keyed on the frame's own text to stay idempotent across a stream replay.
  const dupe = segments.some((s) => s.kind === 'user' && !s.id && s.text === frame.text);
  if (dupe) return segments as TranscriptSegment[];
  return appendUserTurn(segments, { id: frame.id, text: frame.text, status: 'sent' });
}

/** Tick the turn the model has just drained. Returns the SAME array when nothing matches, so
 *  an unrelated or replayed frame re-renders nothing. */
export function markSteerConsumed(
  segments: readonly TranscriptSegment[],
  id: string,
): TranscriptSegment[] {
  if (!id) return segments as TranscriptSegment[];
  let hit = false;
  const next = segments.map((s) => {
    if (s.kind === 'user' && s.id === id && s.status === 'sent') {
      hit = true;
      return { ...s, status: 'consumed' as const };
    }
    return s;
  });
  return hit ? next : (segments as TranscriptSegment[]);
}

/** The run ended, so any steer that never reached a tool-call boundary was never applied.
 *  Identity-stable when there are none. */
export function markPendingUnconsumed(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  let hit = false;
  const next = segments.map((s) => {
    if (s.kind === 'user' && s.status === 'sent') {
      hit = true;
      return { ...s, status: 'unconsumed' as const };
    }
    return s;
  });
  return hit ? next : (segments as TranscriptSegment[]);
}

/** Whether the CLI has produced parsed prose yet.
 *
 *  "The Clean tab is empty" has to keep meaning "no MODEL text": the Raw auto-switch exists
 *  for a run whose model has said nothing parseable, and a transcript holding only the user's
 *  own turn is still exactly that run. */
export function hasModelText(segments: readonly TranscriptSegment[]): boolean {
  return segments.some((s) => s.kind === 'model' && s.text.trim().length > 0);
}

/** Validate the persisted column. It arrives as jsonb through an API that may be older or
 *  newer than this bundle, so anything unrecognised yields null and the caller falls back to
 *  the plain prose — one malformed row must never blank a replay. */
export function parseCleanTranscript(value: unknown): TranscriptSegment[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as StoredCleanTranscript).segments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: TranscriptSegment[] = [];
  for (const seg of raw) {
    if (!seg || typeof seg !== 'object' || typeof seg.text !== 'string') return null;
    if (seg.kind === 'model') {
      out.push({ kind: 'model', text: seg.text });
    } else if (seg.kind === 'user') {
      out.push({
        kind: 'user',
        id: typeof seg.steerId === 'string' ? seg.steerId : '',
        text: seg.text,
        // Absent means the outcome was never recorded — a run that ended before the boundary,
        // or a row written before the field existed. Neither is evidence it was applied.
        status:
          seg.consumed === true ? 'consumed' : seg.consumed === false ? 'unconsumed' : 'historical',
      });
    } else {
      return null;
    }
  }
  return out;
}

/** The transcript for a finished run: the persisted one when it exists, otherwise exactly
 *  today's rendering — one prose body, with whatever `steering.nudge` recorded grouped above
 *  it. */
export function buildReplayTranscript(args: {
  transcript: unknown;
  cleanOutput: string;
  restored: readonly RestoredSteer[];
}): TranscriptSegment[] {
  const parsed = parseCleanTranscript(args.transcript);
  if (parsed) return parsed;
  const out: TranscriptSegment[] = [];
  if (args.restored.length > 0) out.push({ kind: 'history', steers: args.restored });
  const prose = args.cleanOutput.replace(/\r/g, '');
  if (prose.length > 0) out.push({ kind: 'model', text: prose });
  return out;
}
