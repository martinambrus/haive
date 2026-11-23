import { describe, expect, it, vi } from 'vitest';
import type { AdminTaskTypeListed } from '@/lib/api-client';
import { createRenderer, findAll, textOf } from '../../../../../test/render-tree';
import TaskTypesPage from './page';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ children, ...props }: { children?: React.ReactNode; href: string }) =>
      createElement('a', props, children),
  };
});
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/task-type-delete-dialog', () => ({ TaskTypeDeleteDialog: () => null }));
vi.mock('@/components/task-type-duplicate-action', () => ({ TaskTypeDuplicateAction: () => null }));
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  listAdminTaskTypes: mocks.list,
  getTaskTypeCatalog: async () => ({ bases: [] }),
  api: { get: async () => ({ customEnabled: true }) },
}));

const row = (selectsOwnProviders: boolean): AdminTaskTypeListed => ({
  slug: 'fx__report',
  displayName: 'Fixture report',
  description: null,
  runListStrategy: 'static',
  stepIds: ['module.fx.agent'],
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
  promptSteps: {},
  fixLoop: null,
  executionContract: null,
  selectsOwnProviders,
  enabled: true,
  selectable: true,
  source: 'module:fx',
  requiresRepository: false,
  sortOrder: 0,
  contentHash: null,
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
  editableFields: ['displayName', 'enabled', 'sortOrder'],
  builtin: false,
  availability: { available: true },
  taskCount: 0,
});

describe('admin task type provider policy', () => {
  it.each([true, false])(
    'shows a read-only policy badge when selectsOwnProviders is %s',
    async (flag) => {
      mocks.list.mockResolvedValue({ taskTypes: [row(flag)] });
      const view = createRenderer(() => <TaskTypesPage />);
      await view.flush();
      const badges = findAll(
        view.tree(),
        (node) => node.tag === 'span' && textOf(node) === 'Selects own providers',
      );
      expect(badges).toHaveLength(flag ? 1 : 0);
      if (flag) {
        expect(badges[0]!.props.className).toContain('text-indigo-300');
        expect(badges[0]!.props.onClick).toBeUndefined();
        expect(badges[0]!.props.role).toBeUndefined();
      }
      expect(
        findAll(view.tree(), (node) => ['input', 'select', 'button'].includes(node.tag)),
      ).toHaveLength(0);
      expect(textOf(view.tree())).toContain('Module fx');
      expect(textOf(view.tree())).toContain('Enabled');
      expect(textOf(view.tree())).toContain('No repository');
    },
  );
});
