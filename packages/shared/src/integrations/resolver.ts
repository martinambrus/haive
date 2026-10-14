import type { schema } from '@haive/database';
import { credentialUsableForPr } from '../forge/known-hosts.js';
import type { IntegrationRequirement } from '../modularity/contracts.js';

type ConnectionRow = typeof schema.integrationConnections.$inferSelect;

export interface ResolverConnection {
  id: string;
  providerId: string;
  scope: ConnectionRow['scope'];
  ownerUserId: string;
  status: ConnectionRow['status'];
  credential: { provider: string | null; host: string } | null;
}

export interface ResolverProvider {
  id: string;
  categories: readonly string[];
  enabled: boolean;
}

export interface ResolverRepository {
  remoteUrl: string | null;
  restricted: boolean;
  allowedConnectionIds: ReadonlySet<string>;
}

export interface ResolverChoice {
  providerId: string | null;
  connectionId: string | null;
}

export interface ResolverPreference {
  providerId: string;
  connectionId: string | null;
}

/** Everything a resolution reads, loaded once: nothing in it is trusted to belong to the owner. */
export interface ResolverContext {
  ownerUserId: string;
  repository: ResolverRepository | null;
  providers: readonly ResolverProvider[];
  connections: readonly ResolverConnection[];
  choices: ReadonlyMap<string, ResolverChoice>;
  grants: ReadonlyMap<string, string>;
  preferences: ReadonlyMap<string, ResolverPreference>;
  defaults: ReadonlyMap<string, string>;
}

export type ResolverTarget = { category: string } | { provider: string };

export type UnresolvedReason =
  | 'no-provider'
  | 'provider-disabled'
  | 'no-connection'
  | 'needs-choice'
  | 'not-allowed-by-repository'
  | 'connection-unavailable'
  | 'no-repository'
  | 'no-remote';

export type ResolutionSource = 'task' | 'grant' | 'user' | 'admin' | 'only' | 'pinned';

export interface SkippedTier {
  tier: 'user' | 'admin';
  providerId: string;
  why: 'disabled' | 'not-connected' | 'not-allowed' | 'not-for-repository';
}

export type TargetResolution =
  | {
      status: 'resolved';
      categoryId: string | null;
      providerId: string;
      connectionId: string;
      source: ResolutionSource;
      skipped: readonly SkippedTier[];
    }
  | {
      status: 'unresolved';
      categoryId: string | null;
      reason: UnresolvedReason;
      providerId: string | null;
      connectionId: string | null;
      candidates: readonly string[];
      skipped: readonly SkippedTier[];
    };

export type IntegrationResolution =
  | {
      requirementId: string;
      status: 'resolved';
      categoryId: string | null;
      providerId: string;
      connectionId: string;
      access: 'read' | 'write';
      source: ResolutionSource;
    }
  | {
      requirementId: string;
      status: 'unresolved';
      categoryId: string | null;
      optional: boolean;
      reason: UnresolvedReason;
      providerId: string | null;
      connectionId: string | null;
      candidates: readonly string[];
    };

const REPOSITORY_BOUND_CATEGORIES: ReadonlySet<string> = new Set(['forge']);

type Account =
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: UnresolvedReason; providerId: string }
  | { kind: 'selected'; connection: ResolverConnection };

const isBlank = (text: string | null): boolean => text === null || text.trim() === '';

function commonProvider(connections: readonly ResolverConnection[]): string | null {
  const ids = new Set(connections.map((c) => c.providerId));
  return ids.size === 1 ? [...ids][0]! : null;
}

export function resolveTarget(ctx: ResolverContext, target: ResolverTarget): TargetResolution {
  const category = 'category' in target ? target.category : null;
  const pinned = 'provider' in target ? target.provider : null;
  const providers = ctx.providers.filter((p) =>
    category !== null ? p.categories.includes(category) : p.id === pinned,
  );
  const skipped: SkippedTier[] = [];
  const unresolved = (
    reason: UnresolvedReason,
    providerId: string | null,
    connectionId: string | null,
    candidates: readonly string[],
  ): TargetResolution => ({
    status: 'unresolved',
    categoryId: category,
    reason,
    providerId,
    connectionId,
    candidates,
    skipped,
  });
  if (providers.length === 0) return unresolved('no-provider', pinned, null, []);

  const repository = ctx.repository;
  const providerIds = new Set(providers.map((p) => p.id));
  const enabledIds = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
  const repositoryBound =
    category !== null
      ? REPOSITORY_BOUND_CATEGORIES.has(category)
      : providers.some((p) => p.categories.some((c) => REPOSITORY_BOUND_CATEGORIES.has(c)));
  const owned = (c: ResolverConnection) => c.scope === 'user' && c.ownerUserId === ctx.ownerUserId;
  const fits = (c: ResolverConnection) =>
    repository !== null &&
    c.credential !== null &&
    credentialUsableForPr(c.credential, repository.remoteUrl);
  const allowed = (c: ResolverConnection) =>
    repository === null || !repository.restricted || repository.allowedConnectionIds.has(c.id);

  const declared = ctx.connections.filter((c) => owned(c) && providerIds.has(c.providerId));
  const active = declared.filter((c) => enabledIds.has(c.providerId));
  const fitting = repositoryBound ? active.filter(fits) : active;
  const usable = fitting.filter(allowed);
  const usableIds = usable.map((c) => c.id);

  const finish = (connection: ResolverConnection, source: ResolutionSource): TargetResolution =>
    connection.status === 'connected'
      ? {
          status: 'resolved',
          categoryId: category,
          providerId: connection.providerId,
          connectionId: connection.id,
          source,
          skipped,
        }
      : unresolved('connection-unavailable', connection.providerId, connection.id, usableIds);

  const account = (connectionId: string): Account => {
    const c = declared.find((x) => x.id === connectionId);
    if (c === undefined) return { kind: 'absent' };
    if (!enabledIds.has(c.providerId)) {
      return { kind: 'blocked', reason: 'provider-disabled', providerId: c.providerId };
    }
    if (repositoryBound) {
      if (repository === null) {
        return { kind: 'blocked', reason: 'no-repository', providerId: c.providerId };
      }
      if (isBlank(repository.remoteUrl)) {
        return { kind: 'blocked', reason: 'no-remote', providerId: c.providerId };
      }
      if (!fits(c)) return { kind: 'absent' };
    }
    if (!allowed(c)) {
      return { kind: 'blocked', reason: 'not-allowed-by-repository', providerId: c.providerId };
    }
    return { kind: 'selected', connection: c };
  };

  const preferred = (
    tier: SkippedTier['tier'],
    providerId: string,
    connectionId: string | null,
  ): TargetResolution | null => {
    const skip = (why: SkippedTier['why']): null => {
      skipped.push({ tier, providerId, why });
      return null;
    };
    if (!enabledIds.has(providerId)) return skip('disabled');
    const own = declared.filter((c) => c.providerId === providerId);
    const ownFitting = repositoryBound ? own.filter(fits) : own;
    const ownUsable = ownFitting.filter(allowed);
    const named = ownUsable.find((c) => c.id === connectionId);
    if (named !== undefined) return finish(named, tier);
    if (ownUsable.length === 1) return finish(ownUsable[0]!, tier);
    if (ownUsable.length > 1) return unresolved('needs-choice', providerId, null, usableIds);
    return skip(
      own.length === 0
        ? 'not-connected'
        : ownFitting.length === 0
          ? 'not-for-repository'
          : 'not-allowed',
    );
  };

  const choice = category === null ? undefined : ctx.choices.get(category);
  if (choice !== undefined) {
    const picked = choice.connectionId === null ? null : account(choice.connectionId);
    if (picked?.kind === 'selected') return finish(picked.connection, 'task');
    if (picked?.kind === 'blocked')
      return unresolved(picked.reason, picked.providerId, null, usableIds);
    return unresolved('needs-choice', choice.providerId, null, usableIds);
  }

  const grantedId = category === null ? undefined : ctx.grants.get(category);
  if (grantedId !== undefined) {
    const granted = account(grantedId);
    if (granted.kind === 'selected') return finish(granted.connection, 'grant');
    if (granted.kind === 'blocked')
      return unresolved(granted.reason, granted.providerId, null, usableIds);
  }

  const preference = category === null ? undefined : ctx.preferences.get(category);
  if (preference !== undefined) {
    const result = preferred('user', preference.providerId, preference.connectionId);
    if (result !== null) return result;
  }

  const adminDefault = category === null ? undefined : ctx.defaults.get(category);
  if (adminDefault !== undefined) {
    const result = preferred('admin', adminDefault, null);
    if (result !== null) return result;
  }

  if (usable.length === 1) return finish(usable[0]!, category === null ? 'pinned' : 'only');
  if (usable.length > 1) return unresolved('needs-choice', commonProvider(usable), null, usableIds);
  if (declared.length === 0) return unresolved('no-connection', null, null, []);
  if (active.length === 0)
    return unresolved('provider-disabled', commonProvider(declared), null, []);
  if (fitting.length === 0) {
    const reason =
      repository === null
        ? 'no-repository'
        : isBlank(repository.remoteUrl)
          ? 'no-remote'
          : 'no-connection';
    return unresolved(reason, commonProvider(active), null, []);
  }
  return unresolved('not-allowed-by-repository', commonProvider(fitting), null, []);
}

export function resolveRequirements(
  ctx: ResolverContext,
  requirements: readonly IntegrationRequirement[],
): IntegrationResolution[] {
  const resolved = new Map<string, TargetResolution>();
  return requirements.map((requirement): IntegrationResolution => {
    const target: ResolverTarget =
      requirement.category !== undefined
        ? { category: requirement.category }
        : { provider: requirement.provider! };
    const key =
      'category' in target ? `category:${target.category}` : `provider:${target.provider}`;
    let result = resolved.get(key);
    if (result === undefined) {
      result = resolveTarget(ctx, target);
      resolved.set(key, result);
    }
    return result.status === 'resolved'
      ? {
          requirementId: requirement.id,
          status: 'resolved',
          categoryId: result.categoryId,
          providerId: result.providerId,
          connectionId: result.connectionId,
          access: requirement.access,
          source: result.source,
        }
      : {
          requirementId: requirement.id,
          status: 'unresolved',
          categoryId: result.categoryId,
          optional: requirement.optional ?? false,
          reason: result.reason,
          providerId: result.providerId,
          connectionId: result.connectionId,
          candidates: result.candidates,
        };
  });
}
