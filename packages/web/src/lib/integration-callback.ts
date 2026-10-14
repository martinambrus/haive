import { completionBody, type CompletionBody } from './integrations';

export type CallbackOutcome =
  | { kind: 'working' }
  | { kind: 'connected'; accountLabel: string }
  | { kind: 'refused'; message: string }
  | { kind: 'nothing' };

/** Reads what the provider sent back, takes it out of the address bar, then asks the api once; never retries. */
export async function finishCallback(input: {
  search: string;
  providerId: string;
  pathname: string;
  replaceUrl: (pathname: string) => void;
  complete: (body: CompletionBody) => Promise<{ connection: { accountLabel: string } }>;
}): Promise<Exclude<CallbackOutcome, { kind: 'working' }>> {
  const body = completionBody(input.search, input.providerId);
  input.replaceUrl(input.pathname);
  if (!body) return { kind: 'nothing' };
  try {
    const res = await input.complete(body);
    return { kind: 'connected', accountLabel: res.connection.accountLabel };
  } catch (err) {
    const message = (err as Error).message;
    return { kind: 'refused', message: message || 'The connection could not be completed.' };
  }
}
