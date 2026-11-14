/** Shared by every useActiveTime consumer, including future plan pages. */
export const ATTENTION_LEASE_KEY = 'haive:active-time:lease';
export const ATTENTION_LEASE_MS = 5000;
export class AttentionLease {
  private held = false;
  constructor(
    private storage: Storage,
    private owner: string,
    private now = Date.now,
    private ttl = ATTENTION_LEASE_MS,
  ) {}

  /** A fresh acquisition establishes a baseline; only a continuous holder counts. */
  touch(): boolean {
    try {
      const now = this.now();
      const raw = this.storage.getItem(ATTENTION_LEASE_KEY);
      let entry = null;
      try {
        entry = raw && raw.length < 256 ? JSON.parse(raw) : null;
      } catch {
        /* replace malformed data */
      }
      const valid =
        entry &&
        typeof entry.owner === 'string' &&
        entry.owner.length <= 64 &&
        Number.isFinite(entry.until) &&
        entry.until > now &&
        entry.until <= now + this.ttl;
      if (valid && entry.owner !== this.owner) {
        this.held = false;
        return false;
      }
      const continuous = this.held && valid && entry.owner === this.owner;
      this.storage.setItem(
        ATTENTION_LEASE_KEY,
        JSON.stringify({ owner: this.owner, until: now + this.ttl }),
      );
      this.held = true;
      return !!continuous;
    } catch {
      // With storage unavailable, fail closed rather than let every tab count.
      this.held = false;
      return false;
    }
  }

  release(): void {
    this.held = false;
    try {
      const raw = this.storage.getItem(ATTENTION_LEASE_KEY);
      if (raw && raw.length < 256 && JSON.parse(raw).owner === this.owner)
        this.storage.removeItem(ATTENTION_LEASE_KEY);
    } catch {
      /* best effort */
    }
  }
}
