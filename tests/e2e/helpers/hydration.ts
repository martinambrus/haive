import { expect, type Page } from '@playwright/test';

// VOLATILE: React stores a node's props under a key that starts with this. It is internal, not an
// API, so a React upgrade may rename it; `waitForReact` names it when its poll times out.
export const REACT_PROPS_KEY_PREFIX = '__reactProps$';

export async function holdScripts(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

export const reactAttached = (page: Page): Promise<boolean> =>
  page.evaluate((prefix) => {
    const form = document.querySelector('form');
    return form !== null && Object.keys(form).some((key) => key.startsWith(prefix));
  }, REACT_PROPS_KEY_PREFIX);

export async function waitForReact(page: Page): Promise<void> {
  await expect
    .poll(() => reactAttached(page), {
      message: `the form never got a ${REACT_PROPS_KEY_PREFIX}* key: React did not attach, or renamed it`,
      timeout: 15_000,
    })
    .toBe(true);
}
