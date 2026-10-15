import { describe, expect, it, vi } from 'vitest';
import { PreferredByKind } from '@/components/integrations/preferred-by-kind';
import PreferredIntegrationsPage from './page';

const title = vi.hoisted(() => vi.fn());

vi.mock('@/lib/use-page-title', () => ({ usePageTitle: title }));

describe('the Preferred by kind page', () => {
  it('is titled for what it holds and shows the preferences panel', () => {
    expect(PreferredIntegrationsPage().type).toBe(PreferredByKind);
    expect(title).toHaveBeenCalledWith('Preferred integrations');
  });
});
