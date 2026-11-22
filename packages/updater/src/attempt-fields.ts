import { CHANNEL_PATTERN } from '@haive/shared/release';
import { literalEnvValues } from './envkeys.js';
import { inInstall } from './install-files.js';

/** Same version syntax accepted by the upgrade API. The journal column is NOT NULL. */
export function attemptVersion(version: string | undefined): string {
  return version && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : 'unknown';
}

/** Best-effort history only, after an early refusal. Never feeds upgrade decisions or invokes
 * Compose while another holder may be changing the install. The held directory and O_NOFOLLOW
 * read protect .env even when another install file is linked or .env is replaced during a read. */
export async function readAttemptInstallFields(
  installDir: string,
  maxBytes = 256 * 1024,
): Promise<{ channel: string; fromVersion: string; note?: string }> {
  try {
    const file = await inInstall(installDir, (dir) => dir.read('.env', maxBytes));
    if (!file || file.bytes.length > maxBytes) throw new Error('unread install settings');
    const fields = literalEnvValues(file.bytes.toString('utf8'), [
      'HAIVE_CHANNEL',
      'HAIVE_VERSION',
    ]);
    const installedChannel = fields.HAIVE_CHANNEL === '' ? 'public' : fields.HAIVE_CHANNEL;
    const channel =
      installedChannel && CHANNEL_PATTERN.test(installedChannel) ? installedChannel : undefined;
    const fromVersion = attemptVersion(fields.HAIVE_VERSION);
    const notes: string[] = [];
    if (!channel) notes.push('Install channel could not be resolved from literal .env settings.');
    if (fromVersion === 'unknown')
      notes.push('Current version could not be resolved from literal .env settings.');
    return {
      channel: channel ?? 'unknown',
      fromVersion,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  } catch {
    // No filesystem errors, paths or raw .env values belong in the journal.
    return {
      channel: 'not-read',
      fromVersion: 'not-read',
      note: 'Install channel and current version were not read: .env was unavailable, unsafe, oversized or invalid.',
    };
  }
}
