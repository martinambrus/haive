import { describe, expect, it } from 'vitest';
import { listIntegrationCategories } from '../src/integrations/index.js';
import {
  CORE_INTEGRATION_CATEGORIES,
  CORE_INTEGRATION_CATEGORY_SPECS,
  integrationCategorySpecSchema,
  integrationProviderSpecSchema,
  integrationRequirementSchema,
  isCategoryId,
} from '../src/modularity/index.js';

describe('core integration category labels', () => {
  it('labels every core category, in the order of the registry', () => {
    expect(CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => spec.id)).toEqual([
      ...CORE_INTEGRATION_CATEGORIES,
    ]);
    for (const spec of CORE_INTEGRATION_CATEGORY_SPECS) {
      expect(integrationCategorySpecSchema.safeParse(spec).success).toBe(true);
    }
  });

  it('names the categories the way the pages show them', () => {
    expect(Object.fromEntries(CORE_INTEGRATION_CATEGORY_SPECS.map((s) => [s.id, s.label]))).toEqual(
      {
        'rich-documents': 'Documents',
        spreadsheets: 'Spreadsheets',
        'file-storage': 'File storage',
        mail: 'Email',
        chat: 'Chat',
        issues: 'Issue tracking',
        wiki: 'Wiki',
        forge: 'Git forge',
      },
    );
  });

  it('lists the core specs through the registry', () => {
    expect(listIntegrationCategories()).toEqual(CORE_INTEGRATION_CATEGORY_SPECS);
  });
});

describe('isCategoryId against the registry', () => {
  it.each([...CORE_INTEGRATION_CATEGORIES])('accepts the core category %s', (id) => {
    expect(isCategoryId(id)).toBe(true);
  });

  it.each(['docs', 'documents', 'calendar', 'forges', 'a'])(
    'refuses %j: well formed, but no category of the registry',
    (id) => {
      expect(isCategoryId(id)).toBe(false);
    },
  );

  it('still takes a module category by its grammar', () => {
    expect(isCategoryId('module.acme.crm')).toBe(true);
    expect(isCategoryId('module.Acme.crm')).toBe(false);
  });

  it('is what a requirement, a provider and a category spec are checked with', () => {
    const requirement = { id: 'docs', access: 'read' } as const;
    expect(
      integrationRequirementSchema.safeParse({ ...requirement, category: 'mail' }).success,
    ).toBe(true);
    expect(
      integrationRequirementSchema.safeParse({ ...requirement, category: 'docs' }).success,
    ).toBe(false);
    expect(integrationCategorySpecSchema.safeParse({ id: 'docs', label: 'Docs' }).success).toBe(
      false,
    );
    const provider = {
      id: 'github',
      displayName: 'GitHub',
      categories: ['forge'],
      selfHosted: false,
      auth: [
        {
          kind: 'token',
          form: { title: 'Token', fields: [{ id: 'token', type: 'text', label: 'Token' }] },
          help: 'Create a token.',
        },
      ],
      operations: [{ opId: 'a_b', description: 'd', inputSchema: {}, access: 'read' }],
    };
    expect(integrationProviderSpecSchema.safeParse(provider).success).toBe(true);
    expect(
      integrationProviderSpecSchema.safeParse({ ...provider, categories: ['forge', 'docs'] })
        .success,
    ).toBe(false);
  });
});
