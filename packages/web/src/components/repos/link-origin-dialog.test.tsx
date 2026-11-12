import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LinkOriginDialog } from './link-origin-dialog';
import { buttons, createRenderer, findAll, fire, textOf, valueOf } from '../../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./github-oauth-connect', async (original) => ({
  ...(await original<typeof import('./github-oauth-connect')>()),
  GithubOauthConnect: () => null,
}));
const h = vi.hoisted(() => ({ get: vi.fn(), link: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: h.get }, linkRepositoryRemote: h.link }));

const saved = { id: 'saved-token', label: 'Work token', host: 'old.example.test' };
const oauth = { id: 'oauth-token', label: 'GitHub OAuth (octocat)', host: 'github.com' };
beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockReset().mockResolvedValue({ credentials: [saved, oauth] });
  h.link.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function mount(currentUrl?: string, currentCredentialsId?: string) {
  const view = createRenderer(() => (
    <LinkOriginDialog
      repositoryId="repo-1"
      currentUrl={currentUrl}
      currentCredentialsId={currentCredentialsId}
      onClose={() => {}}
      onLinked={() => {}}
    />
  ));
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
  };
  await flush();
  const credential = () => findAll(view.tree(), (n) => n.props.id === 'origin-cred')[0]!;
  const submit = async () => {
    fire.click(buttons(view.tree(), currentUrl ? /^change remote$/i : /^link remote$/i)[0]!);
    await flush();
  };
  return { view, flush, credential, submit };
}

describe('remote dialog credential selection', () => {
  it('defaults a re-point to Keep saved, without preselecting OAuth', async () => {
    const t = await mount('https://old.example.test/repo.git', saved.id);
    const options = findAll(t.credential(), (n) => n.tag === 'option');
    const keep = options.find((n) => textOf(n) === 'Keep saved credential (Work token)');
    expect(keep).toBeDefined();
    expect(valueOf(t.credential())).toBe(valueOf(keep!));
    expect(valueOf(t.credential())).not.toBe(oauth.id);
    await t.submit();
    expect(h.link).toHaveBeenCalledExactlyOnceWith('repo-1', {
      remoteUrl: 'https://old.example.test/repo.git',
    });
  });

  it('sends null when removing a saved credential for a public or SSH remote', async () => {
    const t = await mount('https://old.example.test/repo.git', saved.id);
    const none = findAll(t.credential(), (n) => n.tag === 'option').find(
      (n) => textOf(n) === 'None (remove the saved credential)',
    );
    expect(none).toBeDefined();
    fire.type(t.credential(), valueOf(none!));
    fire.type(
      findAll(t.view.tree(), (n) => n.props.id === 'origin-url')[0]!,
      'git@new.test:repo.git',
    );
    t.view.draw();
    await t.submit();
    expect(h.link).toHaveBeenCalledExactlyOnceWith('repo-1', {
      remoteUrl: 'git@new.test:repo.git',
      credentialsId: null,
    });
  });

  it('can choose another credential when re-pointing', async () => {
    const t = await mount('https://old.example.test/repo.git', saved.id);
    fire.type(t.credential(), oauth.id);
    t.view.draw();
    await t.submit();
    expect(h.link).toHaveBeenCalledWith('repo-1', {
      remoteUrl: 'https://old.example.test/repo.git',
      credentialsId: oauth.id,
    });
  });

  it('keeps the first-link OAuth preselect and the existing None behavior', async () => {
    const t = await mount();
    expect(valueOf(t.credential())).toBe(oauth.id);
    expect(textOf(t.credential())).not.toContain('Keep saved credential');
    fire.type(
      findAll(t.view.tree(), (n) => n.props.id === 'origin-url')[0]!,
      'https://github.com/u/r',
    );
    t.view.draw();
    await t.submit();
    expect(h.link).toHaveBeenLastCalledWith('repo-1', {
      remoteUrl: 'https://github.com/u/r',
      credentialsId: oauth.id,
    });
    fire.type(t.credential(), '');
    t.view.draw();
    await t.submit();
    expect(h.link).toHaveBeenLastCalledWith('repo-1', { remoteUrl: 'https://github.com/u/r' });
  });

  it('keeps the saved binding available when the credential list fails', async () => {
    h.get.mockRejectedValue(new Error('unavailable'));
    const t = await mount('https://old.example.test/repo.git', saved.id);
    expect(textOf(t.credential())).toContain('Keep saved credential');
    await t.submit();
    expect(h.link).toHaveBeenCalledExactlyOnceWith('repo-1', {
      remoteUrl: 'https://old.example.test/repo.git',
    });
  });
});
