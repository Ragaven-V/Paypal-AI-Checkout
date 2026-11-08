import { test, expect } from '@playwright/test';

// Fresh browser context per test = fresh session, shopper ID and cookies
test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  page.errors = errors;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ask & Buy' })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(page.errors, 'no console errors or CSP violations').toEqual([]);
});

const cart = (page) => page.getByRole('region', { name: 'Your cart and checkout' });

test('chat recommends products with images, and they can be added to the cart', async ({ page }) => {
  await page.getByRole('button', { name: /Gift for dad under \$50/ }).click();

  const log = page.getByRole('log', { name: /Conversation/ });
  await expect(log.getByText('I need a gift for my dad under $50, he likes coffee')).toBeVisible();
  const addButtons = log.getByRole('button', { name: /^Add .* to cart$/ });
  await expect(addButtons.first()).toBeVisible();

  const images = log.locator('img.product-image');
  await expect(images.first()).toBeVisible();
  expect(await images.first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);

  await log.getByRole('button', { name: 'Add Artisan Ceramic Coffee Mug to cart' }).click();
  await expect(cart(page).getByText('Artisan Ceramic Coffee Mug')).toBeVisible();
  await expect(page.locator('#cart-count')).toHaveText('1 item');
});

test('cart quantity buttons, totals with shipping, and removal', async ({ page }) => {
  await page.getByLabel('Message the shopping assistant').fill('add the mug');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cart(page).getByText('Artisan Ceramic Coffee Mug')).toBeVisible();

  await expect(page.locator('#summary-subtotal')).toHaveText('$16.50');
  await expect(page.locator('#summary-shipping')).toHaveText('$5.99');
  await expect(page.locator('#summary-total')).toHaveText('$22.49');
  await expect(page.locator('#free-shipping-hint')).toHaveText('Add $33.50 more for free shipping');

  await page.getByRole('button', { name: 'Increase quantity of Artisan Ceramic Coffee Mug' }).click();
  await page.getByRole('button', { name: 'Increase quantity of Artisan Ceramic Coffee Mug' }).click();
  await expect(page.locator('#summary-subtotal')).toHaveText('$49.50');
  await page.getByRole('button', { name: 'Increase quantity of Artisan Ceramic Coffee Mug' }).click();
  await expect(page.locator('#summary-shipping')).toHaveText('FREE');
  await expect(page.locator('#free-shipping-hint')).toBeHidden();

  await page.getByRole('button', { name: 'Decrease quantity of Artisan Ceramic Coffee Mug' }).click();
  await expect(page.locator('#cart-count')).toHaveText('3 items');

  await page.getByRole('button', { name: 'Remove Artisan Ceramic Coffee Mug from cart' }).click();
  await expect(cart(page).getByText('Your cart is empty')).toBeVisible();
});

test('cart and chat survive a page reload', async ({ page }) => {
  await page.getByLabel('Message the shopping assistant').fill('add the grinder');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cart(page).getByText('Precision Burr Coffee Grinder')).toBeVisible();

  await page.reload();
  await expect(cart(page).getByText('Precision Burr Coffee Grinder')).toBeVisible();
  await expect(page.getByText('Earlier in this conversation')).toBeVisible();
  await expect(page.getByRole('log').getByText('add the grinder')).toBeVisible();
});

test('My orders dialog: keyboard focus is trapped and returns on Escape', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'My orders' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'My orders' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/No orders yet/)).toBeVisible();

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('create an account, sign out, sign back in', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog', { name: /Sign in/ });
  await dialog.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('dialog', { name: 'Create your account' })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'at least 8 characters' })).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill('a much better password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#account-email')).toHaveText(email);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Something in the cart and chat while signed in...
  await page.getByLabel('Message the shopping assistant').fill('add the mug');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cart(page).getByText('Artisan Ceramic Coffee Mug')).toBeVisible();
  const shopperBefore = await page.evaluate(() => localStorage.getItem('ai_checkout_shopper'));

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // ...is gone after signing out (shared computers), and the browser gets a new shopper ID
  await expect(cart(page).getByText('Your cart is empty')).toBeVisible();
  await expect(page.getByRole('log').getByText('add the mug')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ai_checkout_shopper'))).not.toBe(shopperBefore);

  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('wrong password');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Incorrect email or password' })).toBeVisible();
  // The browser logs the expected 401 from the wrong password; don't count it as a page error
  page.errors.splice(0, page.errors.length, ...page.errors.filter(e => !e.includes('401')));

  await page.getByLabel('Password', { exact: true }).fill('a much better password');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#account-email')).toHaveText(email);

  // Session cookie is HttpOnly: page scripts can't read it
  expect(await page.evaluate(() => document.cookie)).not.toContain('ab_session');
});

test('PayPal area explains when checkout is not configured', async ({ page }) => {
  await expect(page.getByText(/PayPal Sandbox Client ID is not configured/)).toBeVisible();
});

test('admin page: wrong password is refused, right one shows the dashboard', async ({ page }) => {
  await page.goto('/admin');
  await page.getByPlaceholder('Admin password').fill('nope');
  await page.getByRole('button', { name: 'Show orders' }).click();
  await expect(page.getByText('Wrong password. Please try again.')).toBeVisible();
  // The 401 above is expected; don't count it as a page error
  page.errors.length = 0;

  await page.getByPlaceholder('Admin password').fill('e2e-admin-password');
  await page.getByRole('button', { name: 'Show orders' }).click();
  await expect(page.getByRole('heading', { name: 'All orders' })).toBeVisible();
});
