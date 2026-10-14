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
    ]);
  });
});
