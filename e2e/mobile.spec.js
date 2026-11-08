import { test, expect } from '@playwright/test';

test('phone layout: no sideways scrolling, chat and cart usable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ask & Buy' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByLabel('Message the shopping assistant').fill('add the kettle');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#cart-count')).toHaveText('1 item');

  const afterChat = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(afterChat).toBeLessThanOrEqual(0);
});
