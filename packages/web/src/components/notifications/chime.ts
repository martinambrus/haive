/** Built-in two-tone chime (A5 → E6), ~0.6s, no audio asset. Lazily creates a
 *  single shared AudioContext; resume() handles the suspended-until-gesture
 *  autoplay policy. A chime fired before any user gesture may stay silent —
 *  same budget as Audio.play() rejection, swallowed by design. */
let ctx: AudioContext | null = null;

export function playChime(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const tones: ReadonlyArray<readonly [freq: number, at: number]> = [
      [880, 0],
      [1318.5, 0.18],
    ];
    for (const [freq, at] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.5);
    }
  } catch {
    // Audio unavailable (no device, denied) — notifications stay visual-only.
  }
}
