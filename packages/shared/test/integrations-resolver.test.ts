import { describe, expect, it } from 'vitest';
import {
  resolveRequirements,
  resolveTarget,
  type ResolverConnection,
  type ResolverContext,
  type ResolverProvider,
  type ResolverRepository,
  type ResolverTarget,
  type TargetResolution,
} from '../src/integrations/index.js';
import type { IntegrationRequirement } from '../src/modularity/index.js';

const A = 'user-a';
const B = 'user-b';

const PROVIDERS: ResolverProvider[] = [
  { id: 'github', categories: ['forge'], enabled: true },
  { id: 'gitlab', categories: ['forge'], enabled: true },
  { id: 'gitea', categories: ['forge'], enabled: true },
  { id: 'docs-a', categories: ['rich-documents'], enabled: true },
  { id: 'docs-b', categories: ['rich-documents'], enabled: true },
];

const credential = (provider: string | null, host: string) => ({ provider, host });
function conn(
  id: string,
  providerId: string,
  over: Partial<ResolverConnection> = {},
): ResolverConnection {
  return {
    id,
    providerId,
    scope: 'user',
    ownerUserId: A,
    status: 'connected',
    credential: null,
    ...over,
  };
}

const gh1 = conn('gh1', 'github', { credential: credential('github', 'github.com') });
const gh2 = conn('gh2', 'github', { credential: credential(null, 'github.com') });
const gl = conn('gl', 'gitlab', { credential: credential('gitlab', 'gitlab.com') });
const giteaSelf = conn('giteaSelf', 'gitea', {
  credential: credential('gitea', 'git.example.com'),
});
const giteaNoProv = conn('giteaNoProv', 'gitea', {
  credential: credential(null, 'git.example.com'),
});
const docsA = conn('docsA', 'docs-a');
const docsB = conn('docsB', 'docs-b', { status: 'needs_reauth' });
const docsB2 = conn('docsB2', 'docs-b', { ownerUserId: B });
const ghB = conn('ghB', 'github', {
  ownerUserId: B,
  credential: credential('github', 'github.com'),
});
const ALL = [gh1, gh2, gl, giteaSelf, giteaNoProv, docsA, docsB, docsB2, ghB];

const repo = (
  remoteUrl: string | null,
  over: Partial<ResolverRepository> = {},
): ResolverRepository => ({
  remoteUrl,
  restricted: false,
  allowedConnectionIds: new Set(),
  ...over,
});
const GITHUB = repo('https://github.com/acme/app.git');
const GITLAB = repo('git@gitlab.com:acme/app.git');
const SELF = repo('ssh://git@git.example.com/acme/app.git');
const NO_REMOTE = repo(null);

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    ownerUserId: A,
    repository: GITHUB,
    providers: PROVIDERS,
    connections: ALL,
    choices: new Map(),
    grants: new Map(),
    preferences: new Map(),
    defaults: new Map(),
    ...over,
  };
}
const docsCtx = (over: Partial<ResolverContext> = {}) =>
  ctx({ repository: null, connections: [docsA, docsB, docsB2], ...over });

const FORGE: ResolverTarget = { category: 'forge' };
const DOCS: ResolverTarget = { category: 'rich-documents' };
const without = (...ids: string[]) =>
  PROVIDERS.map((p) => (ids.includes(p.id) ? { ...p, enabled: false } : p));
const picked = (category: string, providerId: string, connectionId: string | null = null) =>
  new Map([[category, { providerId, connectionId }]]);

function outcome(r: TargetResolution): string {
  return r.status === 'resolved' ? `${r.connectionId}/${r.source}` : r.reason;
}
function unresolved(r: TargetResolution) {
  if (r.status !== 'unresolved') throw new Error(`resolved ${r.connectionId}`);
  return r;
}

describe('the precedence of the tiers', () => {
  const a1 = conn('a1', 'docs-a');
  const a2 = conn('a2', 'docs-a');
  const a3 = conn('a3', 'docs-a');
  const b1 = conn('b1', 'docs-b');
  const tiers = {
    choices: picked('rich-documents', 'docs-a', 'a1'),
    grants: new Map([['rich-documents', 'a2']]),
    preferences: picked('rich-documents', 'docs-a', 'a3'),
    defaults: new Map([['rich-documents', 'docs-b']]),
  };
  const base = { repository: null, connections: [a1, a2, a3, b1] };

  it.each([
    ['the task choice', ctx({ ...base, ...tiers }), 'a1/task'],
    ['the task grant', ctx({ ...base, ...tiers, choices: new Map() }), 'a2/grant'],
    [
      'the user preference',
      ctx({ ...base, ...tiers, choices: new Map(), grants: new Map() }),
      'a3/user',
    ],
    ['the admin default', ctx({ ...base, defaults: tiers.defaults }), 'b1/admin'],
    ['the only connection', ctx({ repository: null, connections: [a1] }), 'a1/only'],
  ])('%s wins when every tier above it is absent', (_tier, context, expected) => {
    expect(outcome(resolveTarget(context, DOCS))).toBe(expected);
  });

  it('leaves several connections and no tier to the user', () => {
    const r = unresolved(resolveTarget(ctx(base), DOCS));
    expect(r.reason).toBe('needs-choice');
    expect(r.providerId).toBeNull();
    expect(r.candidates).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('lets a preference name a provider alone: its single account wins, several are a choice', () => {
    const one = ctx({ ...base, preferences: picked('rich-documents', 'docs-b') });
    expect(outcome(resolveTarget(one, DOCS))).toBe('b1/user');
    const several = ctx({ ...base, preferences: picked('rich-documents', 'docs-a') });
    const r = unresolved(resolveTarget(several, DOCS));
    expect(r.reason).toBe('needs-choice');
    expect(r.providerId).toBe('docs-a');
  });

  it('falls to the provider alone when the account a preference names is not usable', () => {
    const context = ctx({ ...base, preferences: picked('rich-documents', 'docs-b', 'gone') });
    expect(outcome(resolveTarget(context, DOCS))).toBe('b1/user');
  });

  it('leaves an admin default with several accounts of its provider to the user', () => {
    const context = ctx({ ...base, defaults: new Map([['rich-documents', 'docs-a']]) });
    const r = unresolved(resolveTarget(context, DOCS));
    expect(r).toMatchObject({ reason: 'needs-choice', providerId: 'docs-a' });
  });
});

describe('every unresolved reason', () => {
  it('no-provider: nothing registered fills the category', () => {
    const r = unresolved(resolveTarget(ctx(), { category: 'chat' }));
    expect(r).toMatchObject({ reason: 'no-provider', providerId: null, connectionId: null });
    expect(r.candidates).toEqual([]);
  });

  it('no-provider: a category nobody knows', () => {
    expect(outcome(resolveTarget(ctx(), { category: 'nonsense' }))).toBe('no-provider');
  });

  it('provider-disabled: every provider the owner has an account with is switched off', () => {
    const context = ctx({ providers: without('github'), connections: [gh1, gh2] });
    const r = unresolved(resolveTarget(context, FORGE));
    expect(r).toMatchObject({ reason: 'provider-disabled', providerId: 'github' });
  });

  it('no-connection: the owner connected no account of the category', () => {
    expect(outcome(resolveTarget(ctx({ connections: [gh1, gh2] }), DOCS))).toBe('no-connection');
    expect(outcome(resolveTarget(ctx({ connections: [docsB2, ghB] }), FORGE))).toBe(
      'no-connection',
    );
    expect(outcome(resolveTarget(ctx({ connections: [] }), DOCS))).toBe('no-connection');
  });

  it('needs-choice: two accounts of the repository, nothing chosen', () => {
    const r = unresolved(resolveTarget(ctx(), FORGE));
    expect(r).toMatchObject({ reason: 'needs-choice', providerId: 'github', connectionId: null });
    expect(r.candidates).toEqual(['gh1', 'gh2']);
  });

  it('not-allowed-by-repository: a restricted repository with no entry allows nothing', () => {
    const r = unresolved(
      resolveTarget(ctx({ repository: repo(GITHUB.remoteUrl, { restricted: true }) }), FORGE),
    );
    expect(r.reason).toBe('not-allowed-by-repository');
    expect(r.candidates).toEqual([]);
  });

  it('connection-unavailable: the preferred account needs to be connected again', () => {
    const r = unresolved(
      resolveTarget(docsCtx({ preferences: picked('rich-documents', 'docs-b') }), DOCS),
    );
    expect(r).toMatchObject({
      reason: 'connection-unavailable',
      providerId: 'docs-b',
      connectionId: 'docsB',
    });
  });

  it('no-repository: a repository-less task has no forge to fit', () => {
    expect(outcome(resolveTarget(ctx({ repository: null }), FORGE))).toBe('no-repository');
  });

  it('no-remote: a repository with no remote url fits no forge account', () => {
    expect(outcome(resolveTarget(ctx({ repository: NO_REMOTE }), FORGE))).toBe('no-remote');
    expect(outcome(resolveTarget(ctx({ repository: repo('  ') }), FORGE))).toBe('no-remote');
  });

  it('carries the pieces of a picker only where there is something to pick', () => {
    for (const context of [
      ctx({ repository: null }),
      ctx({ repository: NO_REMOTE }),
      ctx({ providers: without('github'), connections: [gh1, gh2] }),
      ctx({ connections: [] }),
    ]) {
      const r = unresolved(resolveTarget(context, FORGE));
      expect(r.connectionId).toBeNull();
      expect(r.candidates).toEqual([]);
    }
  });
});

describe('the status of the selected connection', () => {
  it('is checked after a preference picks the account, so an expired token never changes vendor', () => {
    const r = unresolved(
      resolveTarget(docsCtx({ preferences: picked('rich-documents', 'docs-b') }), DOCS),
    );
    expect(r.reason).toBe('connection-unavailable');
    expect(r.connectionId).toBe('docsB');
    expect(r.connectionId).not.toBe('docsA');
  });

  it.each(['needs_reauth', 'revoked', 'provider_unavailable'] as const)(
    'refuses a %s connection that is the only one',
    (status) => {
      const r = unresolved(
        resolveTarget(
          ctx({ repository: null, connections: [conn('x', 'docs-a', { status })] }),
          DOCS,
        ),
      );
      expect(r).toMatchObject({
        reason: 'connection-unavailable',
        connectionId: 'x',
        providerId: 'docs-a',
      });
    },
  );

  it('is checked after a task choice and after a grant', () => {
    const choice = docsCtx({ choices: picked('rich-documents', 'docs-b', 'docsB') });
    expect(outcome(resolveTarget(choice, DOCS))).toBe('connection-unavailable');
    const grant = docsCtx({ grants: new Map([['rich-documents', 'docsB']]) });
    expect(outcome(resolveTarget(grant, DOCS))).toBe('connection-unavailable');
  });

  it('keeps the account a preference names even when the provider has a connected one', () => {
    const other = conn('docsB3', 'docs-b');
    const context = docsCtx({
      connections: [docsB, other],
      preferences: picked('rich-documents', 'docs-b', 'docsB'),
    });
    expect(unresolved(resolveTarget(context, DOCS)).connectionId).toBe('docsB');
  });

  it('is not a filter of the candidates a picker offers', () => {
    const r = unresolved(resolveTarget(docsCtx({ connections: [docsA, docsB] }), DOCS));
    expect(r.reason).toBe('needs-choice');
    expect(r.candidates).toEqual(['docsA', 'docsB']);
  });
});

describe('a tier that cannot be used is skipped, a choice is not', () => {
  it.each([
    [
      'disabled',
      docsCtx({
        providers: without('docs-b'),
        preferences: picked('rich-documents', 'docs-b'),
        defaults: new Map([['rich-documents', 'docs-a']]),
      }),
      DOCS,
      'docsA/admin',
      { tier: 'user', providerId: 'docs-b', why: 'disabled' },
    ],
    [
      'not-connected',
      docsCtx({ connections: [docsA], preferences: picked('rich-documents', 'docs-b') }),
      DOCS,
      'docsA/only',
      { tier: 'user', providerId: 'docs-b', why: 'not-connected' },
    ],
    [
      'not-for-repository',
      ctx({ preferences: picked('forge', 'gitlab') }),
      FORGE,
      'needs-choice',
      { tier: 'user', providerId: 'gitlab', why: 'not-for-repository' },
    ],
    [
      'not-allowed',
      ctx({
        repository: repo(GITHUB.remoteUrl, { restricted: true }),
        preferences: picked('forge', 'github'),
      }),
      FORGE,
      'not-allowed-by-repository',
      { tier: 'user', providerId: 'github', why: 'not-allowed' },
    ],
    [
      'an admin default',
      ctx({ defaults: new Map([['forge', 'gitlab']]) }),
      FORGE,
      'needs-choice',
      { tier: 'admin', providerId: 'gitlab', why: 'not-for-repository' },
    ],
  ])('records %s and moves on', (_why, context, target, expected, skip) => {
    const r = resolveTarget(context, target);
    expect(outcome(r)).toBe(expected);
    expect(r.skipped).toEqual([skip]);
  });

  it('records nothing when every tier above the winner was absent', () => {
    expect(resolveTarget(docsCtx({ connections: [docsA] }), DOCS).skipped).toEqual([]);
  });

  it('records both tiers when both were unusable', () => {
    const r = resolveTarget(
      docsCtx({
        connections: [docsA],
        providers: without('docs-b'),
        preferences: picked('rich-documents', 'docs-b'),
        defaults: new Map([['rich-documents', 'docs-b']]),
      }),
      DOCS,
    );
    expect(outcome(r)).toBe('docsA/only');
    expect(r.skipped).toEqual([
      { tier: 'user', providerId: 'docs-b', why: 'disabled' },
      { tier: 'admin', providerId: 'docs-b', why: 'disabled' },
    ]);
  });

  it('never skips a task choice whose account is gone: the user chooses again', () => {
    const r = unresolved(
      resolveTarget(
        docsCtx({
          choices: picked('rich-documents', 'docs-b'),
          preferences: picked('rich-documents', 'docs-a', 'docsA'),
        }),
        DOCS,
      ),
    );
    expect(r).toMatchObject({ reason: 'needs-choice', providerId: 'docs-b' });
    expect(r.candidates).toEqual(['docsA', 'docsB']);
  });

  it('never skips a task choice whose provider is switched off', () => {
    const r = resolveTarget(
      docsCtx({
        providers: without('docs-a'),
        choices: picked('rich-documents', 'docs-a', 'docsA'),
        preferences: picked('rich-documents', 'docs-b'),
      }),
      DOCS,
    );
    expect(unresolved(r)).toMatchObject({ reason: 'provider-disabled', providerId: 'docs-a' });
  });

  it('never skips a task choice that the repository does not allow', () => {
    const r = resolveTarget(
      ctx({
        repository: repo(GITHUB.remoteUrl, {
          restricted: true,
          allowedConnectionIds: new Set(['gh2']),
        }),
        choices: picked('forge', 'github', 'gh1'),
        preferences: picked('forge', 'github', 'gh2'),
      }),
      FORGE,
    );
    const u = unresolved(r);
    expect(u.reason).toBe('not-allowed-by-repository');
    expect(u.candidates).toEqual(['gh2']);
  });

  it('never skips a task choice that does not fit the repository', () => {
    const r = resolveTarget(
      ctx({
        choices: picked('forge', 'gitlab', 'gl'),
        preferences: picked('forge', 'github', 'gh2'),
      }),
      FORGE,
    );
    expect(unresolved(r)).toMatchObject({ reason: 'needs-choice', providerId: 'gitlab' });
  });
});

describe('a connection of another user', () => {
  it('is no candidate and not the only connection', () => {
    expect(outcome(resolveTarget(docsCtx({ connections: [docsB2] }), DOCS))).toBe('no-connection');
    expect(outcome(resolveTarget(ctx({ connections: [ghB] }), FORGE))).toBe('no-connection');
  });

  it('is its owner own connection for that owner', () => {
    expect(outcome(resolveTarget(docsCtx({ ownerUserId: B }), DOCS))).toBe('docsB2/only');
  });

  it('in the task choice never resolves: the user chooses again', () => {
    const r = unresolved(
      resolveTarget(docsCtx({ choices: picked('rich-documents', 'docs-b', 'docsB2') }), DOCS),
    );
    expect(r).toMatchObject({ reason: 'needs-choice', providerId: 'docs-b' });
    expect(r.candidates).toEqual(['docsA', 'docsB']);
  });

  it('in the preference never resolves: the provider falls back to the owner accounts', () => {
    const r = unresolved(
      resolveTarget(docsCtx({ preferences: picked('rich-documents', 'docs-b', 'docsB2') }), DOCS),
    );
    expect(r.connectionId).toBe('docsB');
    expect(r.candidates).not.toContain('docsB2');
  });

  it('in the task grant never resolves: the grant is not there for the owner', () => {
    const r = unresolved(
      resolveTarget(docsCtx({ grants: new Map([['rich-documents', 'docsB2']]) }), DOCS),
    );
    expect(r.reason).toBe('needs-choice');
    expect(r.candidates).toEqual(['docsA', 'docsB']);
  });

  it('in the repository allow-list allows nothing of the owner and is itself no candidate', () => {
    const r = unresolved(
      resolveTarget(
        ctx({
          repository: repo(GITHUB.remoteUrl, {
            restricted: true,
            allowedConnectionIds: new Set(['ghB']),
          }),
        }),
        FORGE,
      ),
    );
    expect(r.reason).toBe('not-allowed-by-repository');
    expect(r.candidates).toEqual([]);
    expect(r.connectionId).toBeNull();
  });

  it('stays out of the picker even when an allow-list lists it beside the owner accounts', () => {
    const context = ctx({
      repository: repo(GITHUB.remoteUrl, {
        restricted: true,
        allowedConnectionIds: new Set(['ghB', 'gh1']),
      }),
    });
    expect(outcome(resolveTarget(context, FORGE))).toBe('gh1/only');
  });

  it('is not reached through a shared connection either: shared connections are not served yet', () => {
    const shared = conn('docsShared', 'docs-a', { scope: 'shared' });
    expect(outcome(resolveTarget(docsCtx({ connections: [shared] }), DOCS))).toBe('no-connection');
    expect(outcome(resolveTarget(docsCtx({ connections: [shared], ownerUserId: B }), DOCS))).toBe(
      'no-connection',
    );
  });
});

describe('the repository allow-list', () => {
  it('allows the listed accounts of a restricted repository and no other', () => {
    const context = ctx({
      repository: repo(GITHUB.remoteUrl, {
        restricted: true,
        allowedConnectionIds: new Set(['gh2']),
      }),
    });
    expect(outcome(resolveTarget(context, FORGE))).toBe('gh2/only');
  });

  it('restricts on the switch, not on whether it has entries', () => {
    const switchedOnEmpty = ctx({ repository: repo(GITHUB.remoteUrl, { restricted: true }) });
    expect(outcome(resolveTarget(switchedOnEmpty, FORGE))).toBe('not-allowed-by-repository');
    const entriesWithoutSwitch = ctx({
      repository: repo(GITHUB.remoteUrl, { allowedConnectionIds: new Set(['gh1']) }),
    });
    const r = unresolved(resolveTarget(entriesWithoutSwitch, FORGE));
    expect(r.reason).toBe('needs-choice');
    expect(r.candidates).toEqual(['gh1', 'gh2']);
  });

  it('is per repository: it holds back an account of any category it does not list', () => {
    const context = ctx({
      repository: repo(GITHUB.remoteUrl, {
        restricted: true,
        allowedConnectionIds: new Set(['gh2']),
      }),
      connections: [gh2, docsA],
    });
    expect(outcome(resolveTarget(context, DOCS))).toBe('not-allowed-by-repository');
  });

  it('does not touch a task without a repository', () => {
    expect(outcome(resolveTarget(ctx({ repository: null, connections: [docsA] }), DOCS))).toBe(
      'docsA/only',
    );
  });
});

describe('forge is bound to the repository', () => {
  it('offers the accounts that fit the github.com remote and resolves a preferred account', () => {
    const r = unresolved(resolveTarget(ctx(), FORGE));
    expect(r.candidates).toEqual(['gh1', 'gh2']);
    expect(
      outcome(resolveTarget(ctx({ preferences: picked('forge', 'github', 'gh2') }), FORGE)),
    ).toBe('gh2/user');
  });

  it('finds no connection on gitlab.com when the owner has only github accounts', () => {
    expect(
      outcome(resolveTarget(ctx({ repository: GITLAB, connections: [gh1, gh2] }), FORGE)),
    ).toBe('no-connection');
    expect(outcome(resolveTarget(ctx({ repository: GITLAB }), FORGE))).toBe('gl/only');
  });

  it('takes only the self-hosted account that names its forge for a self-hosted remote', () => {
    expect(outcome(resolveTarget(ctx({ repository: SELF }), FORGE))).toBe('giteaSelf/only');
  });

  it('never takes a forge account that has no Git credential', () => {
    const bare = conn('gh0', 'github');
    expect(outcome(resolveTarget(ctx({ connections: [bare] }), FORGE))).toBe('no-connection');
  });

  it('names the missing repository or remote before a choice is even looked at', () => {
    const choice = picked('forge', 'github', 'gh1');
    expect(outcome(resolveTarget(ctx({ repository: null, choices: choice }), FORGE))).toBe(
      'no-repository',
    );
    expect(outcome(resolveTarget(ctx({ repository: NO_REMOTE, choices: choice }), FORGE))).toBe(
      'no-remote',
    );
  });

  it('resolves the other categories of a repository-less task normally', () => {
    expect(outcome(resolveTarget(ctx({ repository: null, connections: [docsA] }), DOCS))).toBe(
      'docsA/only',
    );
    expect(outcome(resolveTarget(ctx({ repository: NO_REMOTE, connections: [docsA] }), DOCS))).toBe(
      'docsA/only',
    );
  });
});

describe('the task grant', () => {
  const a1 = conn('a1', 'docs-a');
  const a2 = conn('a2', 'docs-a');
  const b1 = conn('b1', 'docs-b');
  const base = { repository: null, connections: [a1, a2, b1] };

  it('wins over a preference and an admin default', () => {
    const context = ctx({
      ...base,
      grants: new Map([['rich-documents', 'a2']]),
      preferences: picked('rich-documents', 'docs-a', 'a1'),
      defaults: new Map([['rich-documents', 'docs-b']]),
    });
    expect(outcome(resolveTarget(context, DOCS))).toBe('a2/grant');
  });

  it('loses to a task choice', () => {
    const context = ctx({
      ...base,
      choices: picked('rich-documents', 'docs-a', 'a1'),
      grants: new Map([['rich-documents', 'a2']]),
    });
    expect(outcome(resolveTarget(context, DOCS))).toBe('a1/task');
  });

  it('is per category', () => {
    const context = ctx({
      ...base,
      connections: [a1, a2, b1, gh1, gh2],
      repository: GITHUB,
      grants: new Map([['rich-documents', 'a2']]),
    });
    expect(outcome(resolveTarget(context, DOCS))).toBe('a2/grant');
    expect(outcome(resolveTarget(context, FORGE))).toBe('needs-choice');
  });

  it('falls through to the next tier when its connection is gone', () => {
    const context = ctx({
      ...base,
      grants: new Map([['rich-documents', 'deleted-connection']]),
      preferences: picked('rich-documents', 'docs-a', 'a1'),
    });
    expect(outcome(resolveTarget(context, DOCS))).toBe('a1/user');
  });

  it('falls through when its connection no longer fits the repository', () => {
    const context = ctx({
      grants: new Map([['forge', 'gl']]),
      preferences: picked('forge', 'github', 'gh2'),
    });
    expect(outcome(resolveTarget(context, FORGE))).toBe('gh2/user');
  });

  it('does not fall through when its provider is switched off', () => {
    const context = ctx({
      ...base,
      providers: without('docs-a'),
      grants: new Map([['rich-documents', 'a2']]),
      preferences: picked('rich-documents', 'docs-b', 'b1'),
    });
    const r = unresolved(resolveTarget(context, DOCS));
    expect(r).toMatchObject({ reason: 'provider-disabled', providerId: 'docs-a' });
    expect(r.candidates).toEqual(['b1']);
  });

  it('does not fall through when the repository no longer allows it', () => {
    const context = ctx({
      repository: repo(GITHUB.remoteUrl, {
        restricted: true,
        allowedConnectionIds: new Set(['gh2']),
      }),
      grants: new Map([['forge', 'gh1']]),
      preferences: picked('forge', 'github', 'gh2'),
    });
    expect(outcome(resolveTarget(context, FORGE))).toBe('not-allowed-by-repository');
  });

  it('does not fall through when the account needs to be connected again', () => {
    const context = docsCtx({
      grants: new Map([['rich-documents', 'docsB']]),
      preferences: picked('rich-documents', 'docs-a', 'docsA'),
    });
    expect(unresolved(resolveTarget(context, DOCS))).toMatchObject({
      reason: 'connection-unavailable',
      connectionId: 'docsB',
    });
  });
});

describe('a pinned provider', () => {
  const pinned = (provider: string): ResolverTarget => ({ provider });

  it('resolves its single account and asks for a choice between two', () => {
    const one = resolveTarget(docsCtx({ connections: [docsA, docsB2] }), pinned('docs-a'));
    expect(one).toMatchObject({
      status: 'resolved',
      connectionId: 'docsA',
      source: 'pinned',
      categoryId: null,
    });
    const two = unresolved(
      resolveTarget(docsCtx({ connections: [docsA, conn('docsA2', 'docs-a')] }), pinned('docs-a')),
    );
    expect(two).toMatchObject({ reason: 'needs-choice', providerId: 'docs-a', categoryId: null });
    expect(two.candidates).toEqual(['docsA', 'docsA2']);
  });

  it('has no connection when the owner has no account of it', () => {
    expect(outcome(resolveTarget(docsCtx({ connections: [docsB2] }), pinned('docs-b')))).toBe(
      'no-connection',
    );
  });

  it('is refused when the provider is switched off, unknown or needs to be connected again', () => {
    expect(
      outcome(resolveTarget(docsCtx({ providers: without('docs-a') }), pinned('docs-a'))),
    ).toBe('provider-disabled');
    const unknown = unresolved(resolveTarget(docsCtx(), pinned('docs-zzz')));
    expect(unknown).toMatchObject({ reason: 'no-provider', providerId: 'docs-zzz' });
    expect(outcome(resolveTarget(docsCtx(), pinned('docs-b')))).toBe('connection-unavailable');
  });

  it('ignores the tiers of the categories it fills', () => {
    const context = docsCtx({
      choices: picked('rich-documents', 'docs-b', 'docsB'),
      preferences: picked('rich-documents', 'docs-b'),
    });
    expect(outcome(resolveTarget(context, pinned('docs-a')))).toBe('docsA/pinned');
  });

  it('is held to the repository when the provider is a forge', () => {
    expect(unresolved(resolveTarget(ctx(), pinned('github'))).candidates).toEqual(['gh1', 'gh2']);
    expect(outcome(resolveTarget(ctx({ repository: GITLAB }), pinned('github')))).toBe(
      'no-connection',
    );
    expect(outcome(resolveTarget(ctx({ repository: null }), pinned('github')))).toBe(
      'no-repository',
    );
    expect(outcome(resolveTarget(ctx({ repository: SELF }), pinned('gitea')))).toBe(
      'giteaSelf/pinned',
    );
  });
});

describe('resolveRequirements', () => {
  const requirements: IntegrationRequirement[] = [
    { id: 'docs', category: 'rich-documents', access: 'read' },
    { id: 'code', category: 'forge', access: 'write', optional: true },
    { id: 'pin', provider: 'docs-a', access: 'write' },
    { id: 'again', category: 'rich-documents', access: 'write' },
    { id: 'nobody', category: 'chat', access: 'read' },
  ];
  const context = ctx({ connections: [gh1, gh2, docsA] });

  it('answers once per requirement, in order, in the exact shape the dispatch relies on', () => {
    expect(resolveRequirements(context, requirements)).toEqual([
      {
        requirementId: 'docs',
        status: 'resolved',
        categoryId: 'rich-documents',
        providerId: 'docs-a',
        connectionId: 'docsA',
        access: 'read',
        source: 'only',
      },
      {
        requirementId: 'code',
        status: 'unresolved',
        categoryId: 'forge',
        optional: true,
        reason: 'needs-choice',
        providerId: 'github',
        connectionId: null,
        candidates: ['gh1', 'gh2'],
      },
      {
        requirementId: 'pin',
        status: 'resolved',
        categoryId: null,
        providerId: 'docs-a',
        connectionId: 'docsA',
        access: 'write',
        source: 'pinned',
      },
      {
        requirementId: 'again',
        status: 'resolved',
        categoryId: 'rich-documents',
        providerId: 'docs-a',
        connectionId: 'docsA',
        access: 'write',
        source: 'only',
      },
      {
        requirementId: 'nobody',
        status: 'unresolved',
        categoryId: 'chat',
        optional: false,
        reason: 'no-provider',
        providerId: null,
        connectionId: null,
        candidates: [],
      },
    ]);
  });

  it('gives two requirements of one category the same connection', () => {
    const [docs, again] = resolveRequirements(
      docsCtx({ preferences: picked('rich-documents', 'docs-a') }),
      [requirements[0]!, requirements[3]!],
    );
    expect(docs).toMatchObject({ connectionId: 'docsA' });
    expect(again).toMatchObject({ connectionId: 'docsA' });
  });

  it('answers nothing for no requirement', () => {
    expect(resolveRequirements(context, [])).toEqual([]);
  });
});
