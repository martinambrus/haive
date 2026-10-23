import { logger } from '@haive/shared';

const log = logger.child({ module: 'module-pass-scheduler' });

export class ModulePassScheduler {
  private readonly run: () => Promise<void>;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(opts: { run: () => Promise<void>; intervalMs: number }) {
    this.run = opts.run;
    this.intervalMs = opts.intervalMs;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (!this.running) this.launch();
    }, this.intervalMs);
    this.timer.unref();
  }

  request(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.rerun = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  inFlight(): Promise<void> | null {
    return this.running;
  }

  private launch(): void {
    const pass = (async () => {
      try {
        await this.run();
      } catch (err) {
        log.warn({ err }, 'module pass failed');
      }
    })().finally(() => {
      this.running = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.launch();
      }
    });
    this.running = pass;
  }
}
