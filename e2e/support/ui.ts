import type { Locator, Page } from '@playwright/test';

/** Form controls are wrapped in `.field` with a plain <label>; find the control through its wrapper. */
export function field(scope: Page | Locator, label: string | RegExp): Locator {
  const pg = 'page' in scope ? scope.page() : scope;
  return scope.locator('.field', { has: pg.locator('label', { hasText: label }) }).first().locator('input, select, textarea').first();
}
