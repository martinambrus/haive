export function endpointBody(
  status: number,
  text: string,
  holdOpen?: boolean,
): Promise<{
  url: string;
  fetchFn: typeof fetch;
  readonly cancelled: boolean;
  readonly closed: boolean;
  upstreamClosed: Promise<void>;
  close(): Promise<void>;
}>;
export function oversizedJson(body: Record<string, unknown>): string;
