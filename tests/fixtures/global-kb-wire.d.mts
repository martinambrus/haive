export function stalledPostgres(create?: boolean): Promise<{
  url: string;
  queries: string[];
  startups: string[];
  open(): number;
  stop(): Promise<void>;
}>;
export function until(condition: () => boolean): Promise<void>;
export function fakeClock(): void;
