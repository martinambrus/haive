import type { IntegrationConnection } from './integrations';

export interface DeviceStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  { status: 'pending'; interval: number } | { status: 'ok'; connection: IntegrationConnection };

export type DeviceResult =
  | { kind: 'connected'; connection: IntegrationConnection }
  | { kind: 'expired' }
  | { kind: 'cancelled' };

/** One device-code sign-in: shows the code, then polls at the interval the server last reported until it ends. */
export async function runDeviceSignIn(input: {
  start: () => Promise<DeviceStart>;
  poll: (handle: string) => Promise<DevicePoll>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  live: () => boolean;
  onWaiting: (code: { userCode: string; verificationUri: string }) => void;
}): Promise<DeviceResult> {
  const begun = await input.start();
  if (!input.live()) return { kind: 'cancelled' };
  input.onWaiting({ userCode: begun.userCode, verificationUri: begun.verificationUri });
  const deadline = input.now() + begun.expiresIn * 1000;
  let interval = begun.interval;
  while (input.now() < deadline) {
    await input.wait(Math.max(interval, 1) * 1000);
    if (!input.live()) return { kind: 'cancelled' };
    const polled = await input.poll(begun.handle);
    if (polled.status === 'ok') return { kind: 'connected', connection: polled.connection };
    if (!input.live()) return { kind: 'cancelled' };
    interval = polled.interval;
  }
  return { kind: 'expired' };
}
