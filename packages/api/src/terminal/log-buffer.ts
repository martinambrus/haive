const DEFAULT_CAP_CHARS = 1_048_576;

export interface LogBufferSnapshot {
  fullLog: string;
  byteCount: number;
  truncated: boolean;
}

export class TerminalLogBuffer {
  private log = '';
  private byteCount = 0;
  private truncated = false;
  private dirty = false;
  private readonly cap: number;

  constructor(capChars: number = DEFAULT_CAP_CHARS) {
    this.cap = capChars;
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.byteCount += Buffer.byteLength(chunk, 'utf8');
    this.log += chunk;
    if (this.log.length > this.cap) {
      this.log = this.log.slice(-this.cap);
      this.truncated = true;
    }
    this.dirty = true;
  }

  hasPending(): boolean {
    return this.dirty;
  }

  snapshot(): LogBufferSnapshot {
    return { fullLog: this.log, byteCount: this.byteCount, truncated: this.truncated };
  }

  consume(): LogBufferSnapshot {
    this.dirty = false;
    return this.snapshot();
  }

  get capChars(): number {
    return this.cap;
  }
}
