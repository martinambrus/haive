import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import {
  conflictSide,
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import * as audit from '../src/audit.js';
import { writeProjectStateColumn } from '../src/project-state/write.js';
import { persistDetection } from '../src/repo/clone.js';
import { ragSourceSelectionStep } from '../src/step-engine/steps/onboarding/09_7-rag-source-selection.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-000000000003';
const TASK = '00000000-0000-4000-8000-000000000004';
const RENDER = {
  projectInfo: { name: 'test' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
};
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'worker-settings-audit-'));
  dirs.push(root);
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    auditEvents: schema.auditEvents,
    planNodes: schema.planNodes,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: OWNER,
    name: 'test',
    source: 'blank',
    status: 'ready',
    storagePath: root,
    scopeExcludeGlobs: null,
    agentRulesOverride: null,
    rtkEnabled: null,
    renderContext: {
      ...RENDER,
      agentTargets: [],
      cliTargets: [],
      enabledCliProviders: [],
      rtkChoiceRecorded: true,
    },
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: ACTOR,
    repositoryId: REPO,
    type: 'workflow',
    status: 'running',
  });
  const db = fake.db as unknown as Database;
  const write = async (rel: string, text: string) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  };
  const record = async (settings: Record<string, unknown>) => {
    for (const [rel, text] of renderProjectState(
      normalizeProjectState({
        ...emptyProjectState(),
        render: RENDER,
        settings,
      }),
    ))
      await write('.haive-data/state/' + rel, text);
  };
  const sync = () => syncProjectStateFromCheckout(db, { repositoryId: REPO, repoPath: root });
  const repo = () => fake.rows(schema.repositories)[0]!;
  const audits = () => fake.rows(schema.auditEvents);
  return { root, fake, db, write, record, sync, repo, audits };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function refuseAudit(s: Fixture) {
  s.fake.hooks.beforeInsert = (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
}
function event(
  source: string,
  action: string,
  fields: string[],
  actorUserId = OWNER,
  actorKind = 'repository_owner',
) {
  return {
    actorUserId,
    action,
    targetType: 'repository',
    targetId: REPO,
    metadata: expect.objectContaining({ source, fields, actorKind }),
  };
}

describe('worker audited repository settings', () => {
  it('sync audits scope and rules separately, with owner attribution and no values; repeat is silent', async () => {
    const s = await setup();
    await s.record({
      'scope-exclude-globs': ['private/**'],
      'agent-rules': 'private rule text\n',
      'lsp-servers': ['gopls'],
    });
    await s.sync();
    expect(s.repo().scopeExcludeGlobs).toEqual(['private/**']);
    expect(s.repo().agentRulesOverride).toBe('private rule text\n');
    expect(s.audits()).toEqual([
      expect.objectContaining(
        event('project_state_sync', 'repository.scope.update', ['scopeExcludeGlobs']),
      ),
      expect.objectContaining(
        event('project_state_sync', 'repository.security.update', ['agentRulesOverride']),
      ),
    ]);
    await s.sync();
    expect(s.audits()).toHaveLength(2);
  });
  it.each(['audit', 'commit'])(
    'sync rolls settings and audit back when %s fails',
    async (failure) => {
      const s = await setup();
      await s.record({
        'scope-exclude-globs': ['private/**'],
        'agent-rules': 'private rule text\n',
      });
      const logged = vi.spyOn(audit, 'logAuditEvent');
      if (failure === 'audit') refuseAudit(s);
      else
        s.fake.hooks.beforeCommit = () => {
          throw new Error('commit refused');
        };
      await expect(s.sync()).rejects.toThrow('refused');
      expect(s.repo().scopeExcludeGlobs).toBeNull();
      expect(s.repo().agentRulesOverride).toBeNull();
      expect(s.audits()).toEqual([]);
      expect(s.fake.rows(schema.projectStateSync)).toEqual([]);
      expect(logged).not.toHaveBeenCalled();
    },
  );
  it.each(['scope-exclude-globs', 'agent-rules'] as const)(
    'take theirs audits %s once, in the resolution transaction',
    async (name) => {
      const s = await setup();
      const isScope = name === 'scope-exclude-globs';
      const value = isScope ? ['private/**'] : 'private rule text\n';
      const field = isScope ? 'scopeExcludeGlobs' : 'agentRulesOverride';
      await s.record({ [name]: value });
      const id = randomUUID();
      s.fake.insert(schema.projectStateConflicts, {
        id,
        repositoryId: REPO,
        unit: isScope ? 'settings/scope-exclude-globs.json' : 'settings/agent-rules.md',
        detectedAt: new Date(0),
        base: null,
        local: null,
        incoming: conflictSide(value),
        resolvedAt: null,
        resolution: null,
      });
      const answer = () =>
        resolveProjectStateConflict(s.db, {
          repositoryId: REPO,
          userId: OWNER,
          conflictId: id,
          answer: 'take_theirs',
        });
      refuseAudit(s);
      await expect(answer()).rejects.toThrow('audit refused');
      expect(s.repo()[field]).toBeNull();
      expect(s.fake.rows(schema.projectStateConflicts)[0]!.resolvedAt).toBeNull();
      s.fake.hooks.beforeInsert = null;
      await answer();
      await answer();
      expect(s.audits()).toEqual([
        expect.objectContaining(
          event(
            'project_state_resolve',
            isScope ? 'repository.scope.update' : 'repository.security.update',
            [field],
            OWNER,
            'resolving_user',
          ),
        ),
      ]);
      expect(s.repo()[field]).toEqual(value);
    },
  );
  it('RAG selection audits the task user; refusal rolls back scope and dirty revision; no-op is silent', async () => {
    const s = await setup();
    const apply = () =>
      ragSourceSelectionStep.apply(
        {
          db: s.db,
          taskId: TASK,
          userId: ACTOR,
          logger,
        } as unknown as StepContext,
        {
          iteration: 0,
          previousIterations: [],
          detected: {
            framework: null,
            tree: [{ path: 'private', label: 'private', fileCount: 1 }],
            defaultExcludeGlobs: [],
            extensionSet: ['.ts'],
            totalCodeFiles: 1,
          },
          formValues: { selectedDirs: [] },
        },
      );
    refuseAudit(s);
    await expect(apply()).rejects.toThrow('audit refused');
    expect(s.repo().scopeExcludeGlobs).toBeNull();
    expect(s.fake.rows(schema.projectStateOutbox)).toEqual([]);
    s.fake.hooks.beforeInsert = null;
    await apply();
    await apply();
    expect(s.audits()).toEqual([
      expect.objectContaining(
        event(
          'rag_source_selection',
          'repository.scope.update',
          ['scopeExcludeGlobs'],
          ACTOR,
          'task_user',
        ),
      ),
    ]);
  });
  it('a writer import uses its task user and logs only after its preparation commits', async () => {
    const s = await setup();
    await s.record({ 'agent-rules': 'private rule text\n' });
    const logged = vi.spyOn(audit, 'logAuditEvent');
    let commits = 0;
    s.fake.hooks.beforeCommit = () => {
      if (commits++ === 0) expect(logged).not.toHaveBeenCalled();
    };
    await writeProjectStateColumn(s.db, {
      repositoryId: REPO,
      repoPath: s.root,
      column: s.repo().renderContext as never,
      holdingTaskId: TASK,
    });
    expect(s.audits()).toEqual([
      expect.objectContaining(
        event(
          'project_state_sync',
          'repository.security.update',
          ['agentRulesOverride'],
          ACTOR,
          'task_user',
        ),
      ),
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
  it('taking an already-matching pending setting closes the question without an audit', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, { agentRulesOverride: 'same text\n' });
    await s.record({ 'agent-rules': 'same text\n' });
    const id = randomUUID();
    s.fake.insert(schema.projectStateConflicts, {
      id,
      repositoryId: REPO,
      unit: 'settings/agent-rules.md',
      detectedAt: new Date(0),
      base: null,
      local: null,
      incoming: conflictSide('same text\n'),
      resolvedAt: null,
      resolution: null,
    });
    const result = await resolveProjectStateConflict(s.db, {
      repositoryId: REPO,
      userId: OWNER,
      conflictId: id,
      answer: 'take_theirs',
    });
    expect(result.kind).toBe('resolved');
    expect(s.audits()).toEqual([]);
  });
  it('legacy clone import audits only the fill; refused audit leaves the setting empty', async () => {
    const s = await setup();
    await s.write(
      '.haive-data/exclusions.json',
      JSON.stringify({ schemaVersion: 1, scopeExcludeGlobs: ['private/**'] }),
    );
    refuseAudit(s);
    await persistDetection(s.db, REPO, s.root);
    expect(s.repo().scopeExcludeGlobs).toBeNull();
    expect(s.fake.rows(schema.projectStateOutbox)).toEqual([]);
    s.fake.hooks.beforeInsert = null;
    await persistDetection(s.db, REPO, s.root);
    await persistDetection(s.db, REPO, s.root);
    expect(s.repo().scopeExcludeGlobs).toEqual(['private/**']);
    expect(s.audits()).toEqual([
      expect.objectContaining(
        event('clone_import', 'repository.scope.update', ['scopeExcludeGlobs']),
      ),
    ]);
  });
});

describe('Fix-1 scope-save and metadata controls', () => {
  it('an equal RAG selection still updates the timestamp and dirty revision without auditing', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, { scopeExcludeGlobs: [], updatedAt: new Date(0) });
    await ragSourceSelectionStep.apply(
      { db: s.db, taskId: TASK, userId: ACTOR, logger } as unknown as StepContext,
      {
        iteration: 0,
        previousIterations: [],
        detected: {
          framework: null,
          tree: [],
          defaultExcludeGlobs: [],
          extensionSet: [],
          totalCodeFiles: 0,
        },
        formValues: { selectedDirs: [] },
      },
    );
    expect(s.repo().updatedAt).not.toEqual(new Date(0));
    expect(s.fake.rows(schema.projectStateOutbox)).toHaveLength(1);
    expect(s.audits()).toEqual([]);
  });
  it('scope and security metadata match the API summary keys without storing setting values', async () => {
    const s = await setup();
    await s.db.transaction(async (tx) => {
      await audit.auditRepositorySettings(tx, {
        repositoryId: REPO,
        actor: { userId: OWNER, kind: 'repository_owner' },
        source: 'project_state_sync',
        before: { scopeExcludeGlobs: ['kept/**', 'removed/**'], agentRulesOverride: null },
        updates: {
          scopeExcludeGlobs: ['kept/**', 'added/**', 'added/**'],
          agentRulesOverride: 'secret rule text',
        },
      });
    });
    expect(s.audits().map((row) => row.metadata)).toEqual([
      {
        source: 'project_state_sync',
        actorKind: 'repository_owner',
        fields: ['scopeExcludeGlobs'],
        addedCount: 1,
        removedCount: 1,
      },
      {
        source: 'project_state_sync',
        actorKind: 'repository_owner',
        fields: ['agentRulesOverride'],
        values: { agentRulesOverride: true },
      },
    ]);
    expect(JSON.stringify(s.audits())).not.toMatch(/kept|removed\/\*|added\/\*|secret rule text/);
  });
});

describe('worker scope audit delta semantics', () => {
  it.each([
    { before: null, after: [], expected: null },
    { before: [], after: null, expected: null },
    { before: ['kept'], after: ['kept', 'kept'], expected: null },
    { before: ['a', 'b'], after: ['b', 'a'], expected: null },
    { before: null, after: ['added'], expected: { addedCount: 1, removedCount: 0 } },
    { before: ['removed'], after: [], expected: { addedCount: 0, removedCount: 1 } },
    {
      before: ['kept', 'removed'],
      after: ['kept', 'added', 'added'],
      expected: { addedCount: 1, removedCount: 1 },
    },
  ])(
    'matches API set-delta semantics for $before → $after',
    async ({ before, after, expected }) => {
      const s = await setup();
      const events = await s.db.transaction((tx) =>
        audit.auditRepositorySettings(tx, {
          repositoryId: REPO,
          actor: { userId: OWNER, kind: 'repository_owner' },
          source: 'project_state_sync',
          before: { scopeExcludeGlobs: before },
          updates: { scopeExcludeGlobs: after },
        }),
      );
      expect(events).toHaveLength(expected ? 1 : 0);
      expect(s.audits()).toHaveLength(events.length);
      if (expected)
        expect(events[0]!.metadata).toEqual({
          source: 'project_state_sync',
          actorKind: 'repository_owner',
          fields: ['scopeExcludeGlobs'],
          ...expected,
        });
    },
  );

  it('still audits a rules change beside a null-to-empty scope update', async () => {
    const s = await setup();
    const events = await s.db.transaction((tx) =>
      audit.auditRepositorySettings(tx, {
        repositoryId: REPO,
        actor: { userId: OWNER, kind: 'repository_owner' },
        source: 'project_state_sync',
        before: { scopeExcludeGlobs: null, agentRulesOverride: null },
        updates: { scopeExcludeGlobs: [], agentRulesOverride: 'private rule' },
      }),
    );
    expect(events.map((event) => event.action)).toEqual(['repository.security.update']);
  });
});
