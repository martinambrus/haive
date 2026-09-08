import { volumeName, volumePrefix } from '../naming/index.js';
import type { AuthMode, CliProviderName } from '../types/index.js';

/** The family name, not the whole prefix: the install id in front of it comes from the naming
 *  module, so two installs' auth volumes are disjoint and neither's reaper matches the other's.
 *  At the default id every name below is byte-identical to what shipped. */
const VOLUME_FAMILY = 'cli_auth';
const TASK_SEGMENT = 'task';
const PROVIDER_SEGMENT = 'p';
/** Auth-mode segment for the per-user volume of an API-KEY row. Unambiguous because every
 *  other segment around it is either a hex slug (dashes stripped) or a CliProviderName from
 *  a fixed enum, none of which can produce a literal `_k_`. */
const API_KEY_SEGMENT = 'k';

function idSlug(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}

export function cliAuthVolumeName(
  userId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  return volumeName(VOLUME_FAMILY, idSlug(userId), providerName, pathIndex);
}

/** Per-user volume for an API-KEY row, kept apart from the subscription one above.
 *
 *  A row authenticating from an injected env secret must never mount a volume holding
 *  another row's LOGIN artifact. It otherwise does — measured on grok: after a device login
 *  wrote ~/.grok/auth.json into the shared volume, the API-key row mounted it too, and grok
 *  prefers a session token over a key, so the row configured for a key silently spent the
 *  subscription. Every CLI supporting both modes (claude-code, codex, grok) has this shape;
 *  grok only exposed it because its two credentials bill to different accounts. */
export function cliAuthApiKeyVolumeName(
  userId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  return volumeName(VOLUME_FAMILY, idSlug(userId), providerName, API_KEY_SEGMENT, pathIndex);
}

/** The auth volume a provider row mounts. THE single place that decision is made.
 *
 *  It used to be a `isolateAuth ? perProvider : perUser` ternary hand-copied into four call
 *  sites, which is precisely why auth mode never made it into the key: the fix would have had
 *  to be remembered four times. Everything resolving an auth volume must come through here.
 *
 *  The naming is deliberately ASYMMETRIC, and that is a compatibility decision rather than an
 *  aesthetic one. A `subscription` row resolves to exactly the name it always has, because its
 *  volume holds the credential that actually authenticates and renaming it would log every
 *  existing user out of every CLI at once. Only `api_key` rows move, and they lose nothing by
 *  moving: their credential is an env secret, so the volume holds nothing that authenticates.
 *  Do not "tidy" this into a symmetric scheme without a migration that relocates live volumes. */
export interface CliAuthVolumeCtx {
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  authMode: AuthMode;
  isolateAuth: boolean;
}

export function resolveCliAuthUserVolumeName(ctx: CliAuthVolumeCtx, pathIndex: number): string {
  // Already per-row, so two rows can never share it whatever their modes are.
  if (ctx.isolateAuth) {
    return cliAuthProviderVolumeName(ctx.providerId, ctx.providerName, pathIndex);
  }
  if (ctx.authMode === 'api_key') {
    return cliAuthApiKeyVolumeName(ctx.userId, ctx.providerName, pathIndex);
  }
  return cliAuthVolumeName(ctx.userId, ctx.providerName, pathIndex);
}

/** Per-provider isolated auth volume. Used when `cli_providers.isolate_auth=true`
 *  so two providers of the same CLI (e.g. two gemini configs) keep separate
 *  credentials. The provider id slug (first 12 hex chars after stripping dashes)
 *  is enough to disambiguate inside the user's namespace. */
export function cliAuthProviderVolumeName(
  providerId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const providerSlug = providerId.replace(/-/g, '').slice(0, 12);
  return volumeName(VOLUME_FAMILY, PROVIDER_SEGMENT, providerSlug, providerName, pathIndex);
}

export function cliAuthTaskVolumeName(
  taskId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const taskSlug = taskId.replace(/-/g, '').slice(0, 12);
  return volumeName(VOLUME_FAMILY, TASK_SEGMENT, taskSlug, providerName, pathIndex);
}

export function isCliAuthVolume(name: string): boolean {
  return name.startsWith(volumePrefix(VOLUME_FAMILY));
}

/** The prefix a per-TASK auth volume starts with. Exported so the reaper's docker `name=` filter
 *  and the slug arithmetic that reads a task id back out of a volume name derive from the same
 *  place this module builds the name — a filter typed separately is how one install ends up
 *  deleting another's volumes. */
export function cliAuthTaskVolumePrefix(): string {
  return `${volumePrefix(VOLUME_FAMILY)}${TASK_SEGMENT}_`;
}

export function isCliAuthTaskVolume(name: string): boolean {
  return name.startsWith(cliAuthTaskVolumePrefix());
}

export function isCliAuthProviderVolume(name: string): boolean {
  return name.startsWith(`${volumePrefix(VOLUME_FAMILY)}${PROVIDER_SEGMENT}_`);
}
