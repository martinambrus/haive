import type { VerifyCommands } from '@haive/shared/schemas';

export const VERIFY_SLOTS = [
  { key: 'test', label: 'Test' },
  { key: 'lint', label: 'Lint' },
  { key: 'typecheck', label: 'Typecheck' },
] as const;

export type VerifySlotKey = (typeof VERIFY_SLOTS)[number]['key'];
export type VerifyMode = 'auto' | 'off' | 'custom';
export interface VerifySlotState {
  mode: VerifyMode;
  text: string;
}
export type VerifySlots = Record<VerifySlotKey, VerifySlotState>;

export const VERIFY_COMMAND_MAX = 2000;

/** Key absent is Auto, null is Off, a string is Custom. */
export function slotsFromConfig(stored: VerifyCommands | null | undefined): VerifySlots {
  const out = {} as VerifySlots;
  for (const { key } of VERIFY_SLOTS) {
    const v = stored?.[key];
    out[key] =
      v === undefined
        ? { mode: 'auto', text: '' }
        : v === null
          ? { mode: 'off', text: '' }
          : { mode: 'custom', text: v };
  }
  return out;
}

export function configFromSlots(slots: VerifySlots): VerifyCommands {
  const out: VerifyCommands = {};
  for (const { key } of VERIFY_SLOTS) {
    const s = slots[key];
    if (s.mode === 'off') out[key] = null;
    else if (s.mode === 'custom') out[key] = s.text.trim();
  }
  return out;
}

export function verifySlotsError(slots: VerifySlots): string | null {
  for (const { key, label } of VERIFY_SLOTS) {
    const s = slots[key];
    if (s.mode !== 'custom') continue;
    const len = s.text.trim().length;
    if (len === 0) return `Enter a ${label.toLowerCase()} command, or choose Auto or Off.`;
    if (len > VERIFY_COMMAND_MAX) {
      return `The ${label.toLowerCase()} command is longer than ${VERIFY_COMMAND_MAX} characters.`;
    }
  }
  return null;
}

export interface VerifyCommandsApi {
  patch: (path: string, body: unknown) => Promise<unknown>;
  get: (path: string) => Promise<{ verifyCommands?: VerifyCommands | null }>;
}

export type SaveVerifyResult = { ok: true; slots: VerifySlots } | { ok: false; error: string };

/** PATCHes the whole object, then re-reads the stored one so the page shows what was kept. */
export async function saveVerifyCommands(
  client: VerifyCommandsApi,
  repositoryId: string,
  slots: VerifySlots,
): Promise<SaveVerifyResult> {
  const invalid = verifySlotsError(slots);
  if (invalid) return { ok: false, error: invalid };
  try {
    await client.patch(`/repositories/${repositoryId}/tooling`, {
      verifyCommands: configFromSlots(slots),
    });
    const cfg = await client.get(`/repositories/${repositoryId}/tooling-config`);
    return { ok: true, slots: slotsFromConfig(cfg.verifyCommands) };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to save verify commands' };
  }
}
