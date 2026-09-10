import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Invoking a row or header action, whichever shape `ActionMenu` happens to render.
 *
 * The component has two forms and the choice is not the caller's: with two or more actions it
 * renders a collapsed `role="menu"` behind an "Actions" trigger, but with exactly one it renders
 * that action as a plain button and no menu at all ("One action is not a menu: it is that
 * action"). Which form appears therefore depends on how many actions the FIXTURE qualifies for —
 * a `failed` task offers retry/pause/cancel, a `completed` one may offer a single action — so a
 * spec that reaches straight for `getByRole('menuitem')` breaks when a fixture changes state, and
 * one that reaches for `getByRole('button')` broke when the menu was introduced.
 *
 * Asking for the action by name and letting this resolve the shape is what keeps a spec correct
 * across both.
 */

/** Playwright applies `exact` to strings only; passing it alongside a RegExp is meaningless. */
function byName(name: string | RegExp) {
  return typeof name === 'string' ? { name, exact: true } : { name };
}

/**
 * Open the collapsed menu within `scope` and return the panel.
 *
 * Fails loudly when `scope` renders no menu — a caller that wanted the single-button form should
 * use `invokeAction`, which handles both.
 */
export async function openActionMenu(
  scope: Page | Locator,
  menuLabel = 'Actions',
): Promise<Locator> {
  const trigger = scope.getByRole('button', { name: menuLabel, exact: true });
  await expect(trigger, `no "${menuLabel}" trigger in this scope`).toBeVisible();
  // Only when it is shut: these specs open a menu twice in a row often enough that a blind
  // click would toggle the second one closed again.
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const menu = scope.getByRole('menu', { name: menuLabel });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Click the action called `name` inside `scope`.
 *
 * `scope` matters and should be the row or header the action belongs to, never the page: a task
 * page renders "Retry" both on the task header and on every failed step card, and clicking the
 * wrong one posts to `/tasks/:id/steps/:id/action` instead of `/tasks/:id/action` — a mistake that
 * still turns something green while testing the wrong entity entirely.
 */
export async function invokeAction(
  scope: Page | Locator,
  name: string | RegExp,
  opts: { menuLabel?: string } = {},
): Promise<void> {
  const direct = scope.getByRole('button', byName(name));
  if ((await direct.count()) > 0) {
    await direct.first().click();
    return;
  }
  const menu = await openActionMenu(scope, opts.menuLabel ?? 'Actions');
  await menu.getByRole('menuitem', byName(name)).click();
}

/**
 * The action labels currently offered in `scope`, in render order.
 *
 * `ActionMenu` sorts destructive actions last regardless of how a call site lists them, so this is
 * a stable thing to assert against.
 */
export async function actionLabels(
  scope: Page | Locator,
  menuLabel = 'Actions',
): Promise<string[]> {
  const trigger = scope.getByRole('button', { name: menuLabel, exact: true });
  if ((await trigger.count()) === 0) return [];
  const menu = await openActionMenu(scope, menuLabel);
  return (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
}
