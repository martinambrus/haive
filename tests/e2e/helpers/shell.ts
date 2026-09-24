import { expect, type Page } from '@playwright/test';

/** The sidebar is server-rendered, so its controls are visible before React has attached a
 *  handler, and a click or drag in that window is lost. `SidebarNav` sets this once it has
 *  hydrated. It says nothing about the page beside it, which can hydrate later. */
export async function waitForShellHydration(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-shell-hydrated', 'true');
}
