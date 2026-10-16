import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relative: string) =>
  readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8');
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BROKER = withoutComments(source('routes/integration-mcp.ts'));
const TASK_ROUTES = withoutComments(source('routes/tasks/integrations.ts'));
const SHARED = "'@haive/shared/integrations'";

const importsFromShared = (text: string, name: string) =>
  new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*${SHARED}`).test(
    text,
  );

describe('[D10] the one writeAllowedBy', () => {
  it('[D10] is no longer defined in the broker route', () => {
    expect(BROKER).not.toMatch(/\b(?:function|const|let|var)\s+writeAllowedBy\b/);
  });

  it('[D10] is imported by the broker route from @haive/shared/integrations', () => {
    expect(importsFromShared(BROKER, 'writeAllowedBy')).toBe(true);
  });

  it('[D10] is still what the broker route asks for the switch', () => {
    expect(BROKER).toMatch(/\bwriteAllowedBy\(/);
  });
});

describe('[D9] the task choice routes take the dispatch lock first', () => {
  const transactions = [...TASK_ROUTES.matchAll(/db\.transaction\(async \(tx\) => \{\s*([^;]*;)/g)];

  it('[D9] import lockTaskIntegrations from @haive/shared/integrations', () => {
    expect(importsFromShared(TASK_ROUTES, 'lockTaskIntegrations')).toBe(true);
  });

  it('[D9] open exactly two transactions, the PUT and the DELETE of a choice', () => {
    expect(transactions).toHaveLength(2);
  });

  it.each([0, 1])('[D9] start transaction %i with lockTaskIntegrations(tx, <task id>)', (index) => {
    expect(transactions[index]?.[1] ?? '').toMatch(
      /^await lockTaskIntegrations\(\s*tx\s*,\s*(?:task\.id|c\.req\.param\('id'\)|taskId)\s*\)\s*;/,
    );
  });
});
