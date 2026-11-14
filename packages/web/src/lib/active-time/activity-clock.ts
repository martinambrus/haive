/** All timestamps are from the same monotonic clock (performance.now in the hook). */
export const READING_WPM = 150;
export const MIN_READING_IDLE_MS = 60_000;
export const MAX_READING_IDLE_MS = 300_000;
export const PENDING_WORK_IDLE_MS = 15 * 60_000;
export const IFRAME_IDLE_MS = 15 * 60_000;

export function readingAllowanceMs(words: number): number {
  if (!Number.isFinite(words)) return MIN_READING_IDLE_MS;
  return Math.min(
    MAX_READING_IDLE_MS,
    Math.max(MIN_READING_IDLE_MS, (words * 60_000) / READING_WPM),
  );
}

export class ActivityClock {
  epoch = 0;
  private epochAt: number;
  private lastInput: number;
  private lastSample: number;
  private unsampled = 0;
  private reading = MIN_READING_IDLE_MS;
  private measured = false;
  private deadline: number;
  private pending = false;
  private iframe = false;
  private modeAllowance = 0;

  constructor(now: number) {
    this.epochAt = this.lastInput = this.lastSample = now;
    this.deadline = now + this.reading;
  }

  isPresent(now: number): boolean {
    return now < this.deadline;
  }

  sample(now: number, eligible: boolean): number {
    const start = Math.max(this.lastSample, this.epochAt);
    this.lastSample = now;
    const delta = this.unsampled + Math.max(0, Math.min(now, this.deadline) - start);
    this.unsampled = 0;
    return eligible ? delta : 0;
  }

  private requestedModeAllowance(): number {
    return Math.max(this.pending ? PENDING_WORK_IDLE_MS : 0, this.iframe ? IFRAME_IDLE_MS : 0);
  }

  private allowance(): number {
    return Math.max(this.reading, this.modeAllowance);
  }

  private restart(now: number, retainInterval = false): void {
    // Input may arrive many times between ticks. Preserve those completed pieces
    // for the next sample without publishing or touching browser storage on input.
    if (retainInterval)
      this.unsampled += Math.max(
        0,
        Math.min(now, this.deadline) - Math.max(this.lastSample, this.epochAt),
      );
    this.epoch++;
    this.epochAt = this.lastSample = now;
    this.reading = MIN_READING_IDLE_MS;
    this.measured = false;
    this.modeAllowance = this.requestedModeAllowance();
    this.deadline = now + this.allowance();
  }

  input(now: number, retainInterval = false): void {
    this.lastInput = now;
    this.restart(now, retainInterval);
  }

  content(now: number, retainInterval = false): boolean {
    if (now - this.lastInput > PENDING_WORK_IDLE_MS) return false;
    this.restart(now, retainInterval);
    return true;
  }

  setReadingWords(epoch: number, words: number, now: number): void {
    if (epoch !== this.epoch || this.measured || !this.isPresent(now)) return;
    this.measured = true;
    this.reading = readingAllowanceMs(words);
    this.deadline = this.epochAt + this.allowance();
  }

  setModes(now: number, pending: boolean, iframe: boolean): void {
    if (pending === this.pending && iframe === this.iframe) return;
    const present = this.isPresent(now);
    this.pending = pending;
    this.iframe = iframe;
    // A transition cannot resurrect an expired epoch or slide its input time.
    if (present) {
      this.modeAllowance = this.requestedModeAllowance();
      this.deadline = this.epochAt + this.allowance();
    }
  }
}
