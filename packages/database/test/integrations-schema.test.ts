import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';

describe('integration tables', () => {
  it('declares the six tables', () => {
    const names = [
      schema.integrationProviderConfigs,
      schema.integrationConnections,
      schema.integrationGrants,
      schema.integrationUserSettings,
      schema.integrationCategoryPreferences,
      schema.integrationCalls,
    ].map((t) => getTableConfig(t).name);
    expect(names).toEqual([
      'integration_provider_configs',
      'integration_connections',
      'integration_grants',
      'integration_user_settings',
      'integration_category_preferences',
      'integration_calls',
    ]);
  });

  it('keeps the grant target check', () => {
    const checks = getTableConfig(schema.integrationGrants).checks.map((c) => c.name);
    expect(checks).toEqual(['integration_grants_target_check']);
  });

  it('treats a null user as one value in the category preference key', () => {
    const [constraint] = getTableConfig(schema.integrationCategoryPreferences).uniqueConstraints;
    expect(constraint?.nullsNotDistinct).toBe(true);
    expect(constraint?.columns.map((c) => c.name)).toEqual(['user_id', 'category_id']);
  });

  it('keys a connection on its account and on its Git credential, only where those are set', () => {
    const indexes = getTableConfig(schema.integrationConnections).indexes.map((i) => i.config);
    const named = (name: string) => indexes.find((i) => i.name === name);
    const account = named('integration_connections_account_key_idx');
    expect(account?.unique).toBe(true);
    expect(account?.columns.map((c) => (c as { name: string }).name)).toEqual([
      'scope',
      'owner_user_id',
      'provider_id',
      'external_account_id',
    ]);
    expect(account?.where).toBeDefined();
    const credential = named('integration_connections_repo_credential_key_idx');
    expect(credential?.unique).toBe(true);
    expect(credential?.columns.map((c) => (c as { name: string }).name)).toEqual([
      'repo_credential_id',
    ]);
    expect(credential?.where).toBeDefined();
  });

  it('keys user settings on user and provider', () => {
    const [pk] = getTableConfig(schema.integrationUserSettings).primaryKeys;
    expect(pk?.columns.map((c) => c.name)).toEqual(['user_id', 'provider_id']);
  });

  it('keeps the choices of a task per category, and an account gone leaves the provider', () => {
    const config = getTableConfig(schema.taskIntegrationChoices);
    expect(config.name).toBe('task_integration_choices');
    expect(config.columns.map((c) => c.name)).toEqual([
      'task_id',
      'category_id',
      'provider_id',
      'connection_id',
      'updated_at',
    ]);
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['task_id', 'category_id']);
    const references = config.foreignKeys.map((fk) => ({
      from: fk.reference().columns.map((c) => c.name),
      to: getTableConfig(fk.reference().foreignTable).name,
      onDelete: fk.onDelete,
    }));
    expect(references).toEqual([
      { from: ['task_id'], to: 'tasks', onDelete: 'cascade' },
      { from: ['connection_id'], to: 'integration_connections', onDelete: 'set null' },
    ]);
    const providerId = config.columns.find((c) => c.name === 'provider_id');
    expect(providerId?.notNull).toBe(true);
  });

  it('declares the preferred account and the allow-list switch last, the order a migration appends them in', () => {
    const preferences = getTableConfig(schema.integrationCategoryPreferences);
    expect(preferences.columns.at(-1)?.name).toBe('connection_id');
    const account = preferences.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'connection_id'),
    );
    expect(getTableConfig(account!.reference().foreignTable).name).toBe('integration_connections');
    expect(account?.onDelete).toBe('set null');
    const repositories = getTableConfig(schema.repositories);
    const names = repositories.columns.map((c) => c.name);
    const at = names.indexOf('integrations_restricted');
    expect(names[at - 1]).toBe('verify_commands');
    const switchColumn = repositories.columns[at];
    expect(switchColumn?.notNull).toBe(true);
    expect(switchColumn?.default).toBe(false);
  });

  it('keys a task grant on task and category and a repository grant on repository and account', () => {
    const indexes = getTableConfig(schema.integrationGrants).indexes.map((i) => i.config);
    const named = (name: string) => indexes.find((i) => i.name === name);
    const task = named('integration_grants_task_category_key_idx');
    expect(task?.unique).toBe(true);
    expect(task?.columns.map((c) => (c as { name: string }).name)).toEqual([
      'task_id',
      'category_id',
    ]);
    expect(task?.where).toBeDefined();
    const repository = named('integration_grants_repository_connection_key_idx');
    expect(repository?.unique).toBe(true);
    expect(repository?.columns.map((c) => (c as { name: string }).name)).toEqual([
      'repository_id',
      'connection_id',
    ]);
    expect(repository?.where).toBeDefined();
  });

  it('stores no call arguments or results', () => {
    const columns = getTableConfig(schema.integrationCalls).columns.map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'connection_id',
      'provider_id',
      'task_id',
      'task_step_id',
      'cli_invocation_id',
      'tool',
      'access',
      'surface',
      'outcome',
      'created_at',
      'reason',
      'duration_ms',
    ]);
  });

  it('records an attempt before its outcome, so a crash leaves it running', () => {
    expect(schema.integrationCallOutcomeEnum.enumValues).toEqual([
      'ok',
      'refused',
      'error',
      'running',
    ]);
  });

  it('finds the calls of one task and of one invocation by index', () => {
    const indexes = getTableConfig(schema.integrationCalls).indexes.map((i) => i.config);
    expect(
      indexes.map((i) => [i.name, i.columns.map((c) => (c as { name: string }).name)]),
    ).toEqual([
      ['integration_calls_task_id_idx', ['task_id']],
      ['integration_calls_cli_invocation_id_idx', ['cli_invocation_id']],
    ]);
  });

  it('declares the reason and the duration of a call last, both optional', () => {
    const [reason, duration] = getTableConfig(schema.integrationCalls).columns.slice(-2);
    expect([reason?.name, reason?.columnType, reason?.notNull]).toEqual([
      'reason',
      'PgVarchar',
      false,
    ]);
    expect((reason as { length?: number }).length).toBe(64);
    expect([duration?.name, duration?.columnType, duration?.notNull]).toEqual([
      'duration_ms',
      'PgInteger',
      false,
    ]);
  });

  it('declares the integrations a CLI run was given last on the invocation, optional', () => {
    const last = getTableConfig(schema.cliInvocations).columns.at(-1);
    expect([last?.name, last?.columnType, last?.notNull]).toEqual([
      'integrations',
      'PgJsonb',
      false,
    ]);
  });
});
