import { beforeEach, describe, expect, it, vi } from 'vitest';
import CredentialsPage from './page';
import { buttons, createRenderer, fire, textOf } from '../../../../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
const modal = vi.hoisted(() => ({
  props: undefined as { onUpdated?: (credential: Record<string, unknown>) => void } | undefined,
}));
vi.mock('@/components/credential-modal', () => ({
  CredentialModal: (props: { onUpdated?: (credential: Record<string, unknown>) => void }) => {
    modal.props = props;
    return null;
  },
}));
vi.mock('@/components/dialog', async () => {
  const { createElement } = await import('react');
  const wrap = (tag: string) => (props: Record<string, unknown>) => {
    const { children, ...rest } = props;
    return createElement(tag, rest, children as never);
  };
  return {
    Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
      open ? (children as never) : null,
    DialogContent: wrap('div'),
    DialogHeader: wrap('div'),
    DialogTitle: wrap('h3'),
  };
});
const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api }));

const rows = [
  {
    id: 'c1',
    label: 'GitHub OAuth (octocat)',
    host: 'github.com',
    gitName: null,
    gitEmail: null,
    createdAt: '2026-10-14T10:00:00.000Z',
    connection: { accountLabel: 'octocat', providerName: 'GitHub' },
  },
  {
    id: 'c2',
    label: 'Work PAT',
    host: 'git.example.test',
    gitName: null,
    gitEmail: null,
    createdAt: '2026-10-14T10:00:00.000Z',
    connection: null,
  },
];

async function mount() {
  api.get.mockResolvedValue({ credentials: structuredClone(rows) });
  const view = createRenderer(() => <CredentialsPage />);
  await view.flush();
  return view;
}

beforeEach(() => {
  api.get.mockReset();
  api.delete.mockReset();
});

describe('the Git credentials page', () => {
  it('Delete only opens the dialog, naming the connection; nothing is deleted yet', async () => {
    const view = await mount();
    expect(buttons(view.tree(), 'delete')).toHaveLength(2);
    fire.click(buttons(view.tree(), 'delete')[0]!);
    await view.flush();
    expect(api.delete).not.toHaveBeenCalled();
    const text = textOf(view.tree());
    expect(text).toContain('Delete Git credential');
    expect(text).toContain(
      'Delete the Git credential "GitHub OAuth (octocat)"? It is the connection to octocat on GitHub, so that connection is deleted with it. This cannot be undone.',
    );
    expect(buttons(view.tree(), 'delete')).toHaveLength(3);
  });

  it('a credential with no connection gets the short sentence', async () => {
    const view = await mount();
    fire.click(buttons(view.tree(), 'delete')[1]!);
    await view.flush();
    const text = textOf(view.tree());
    expect(text).toContain('Delete the Git credential "Work PAT"? This cannot be undone.');
    expect(text).not.toContain('is the connection to');
  });

  it('Cancel closes the dialog without deleting', async () => {
    const view = await mount();
    fire.click(buttons(view.tree(), 'delete')[0]!);
    await view.flush();
    fire.click(buttons(view.tree(), 'cancel')[0]!);
    await view.flush();
    expect(api.delete).not.toHaveBeenCalled();
    expect(textOf(view.tree())).not.toContain('Delete Git credential');
    expect(textOf(view.tree())).toContain('GitHub OAuth (octocat)');
  });

  it('confirming deletes by id, removes the row and closes the dialog', async () => {
    api.delete.mockResolvedValue({ ok: true });
    const view = await mount();
    fire.click(buttons(view.tree(), 'delete')[0]!);
    await view.flush();
    fire.click(buttons(view.tree(), 'delete').at(-1)!);
    await view.flush();
    await view.flush();
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/repo-credentials/c1');
    const text = textOf(view.tree());
    expect(text).not.toContain('Delete Git credential');
    expect(text).not.toContain('GitHub OAuth (octocat)');
    expect(text).toContain('Work PAT');
  });

  it('a refused delete keeps the row and shows the message inside the dialog', async () => {
    api.delete.mockRejectedValue(
      Object.assign(new Error('nope'), { message: 'Credential in use' }),
    );
    const view = await mount();
    fire.click(buttons(view.tree(), 'delete')[1]!);
    await view.flush();
    fire.click(buttons(view.tree(), 'delete').at(-1)!);
    await view.flush();
    await view.flush();
    const text = textOf(view.tree());
    expect(text).toContain('Credential in use');
    expect(text).toContain('Delete Git credential');
    expect(text).toContain('Work PAT');
    fire.click(buttons(view.tree(), 'cancel')[0]!);
    await view.flush();
    expect(textOf(view.tree())).not.toContain('Credential in use');
  });
  it('reloads the list after an edit, so a connection renamed with its credential is named as it now is', async () => {
    const view = await mount();
    api.get.mockResolvedValue({
      credentials: [
        {
          ...rows[0],
          label: 'Work GitHub',
          connection: { accountLabel: 'Work GitHub', providerName: 'GitHub' },
        },
        rows[1],
      ],
    });

    modal.props?.onUpdated?.({
      id: 'c1',
      label: 'Work GitHub',
      host: 'github.com',
      gitName: null,
      gitEmail: null,
    });
    await view.flush();
    await view.flush();
    fire.click(buttons(view.tree(), 'delete')[0]!);
    await view.flush();

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(textOf(view.tree())).toContain('It is the connection to Work GitHub on GitHub');
  });
});
