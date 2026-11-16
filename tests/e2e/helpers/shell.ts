import { expect, type Page } from '@playwright/test';

/** The sidebar is server-rendered, so its controls are visible before React has attached a
 *  handler, and a click or drag in that window is lost. `SidebarNav` sets this once it has
 *  hydrated. It says nothing about the page beside it, which can hydrate later. */
export async function waitForShellHydration(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-shell-hydrated', 'true');
}

/** Next's dev-tools badge floats in the bottom-left corner, over the sidebar's footer. When the
 *  dev server has anything to report ("1 Issue", "1 Insight") the badge widens and covers the
 *  Sign out button, so a click there is intercepted and times out. The badge is dev-only chrome
 *  no user of a built app sees; hide it before clicking anything in that corner. */
export async function hideNextDevTools(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}
