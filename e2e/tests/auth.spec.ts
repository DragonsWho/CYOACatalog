// Auth flows. MUI TextField quirks: required labels get " *" (getByLabel('Email') misses them) →
// scope to .MuiDialog-paper and use input[type=…]. Tab buttons precede the submit button in DOM:
// getByRole('button',{name:'Log In'}).first() = tab; button[type=submit] = submit.

import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/login';
import { TEST_USER, NEW_USER_PREFIX } from '../constants';

type Page = import('@playwright/test').Page;

async function openLoginDialog(page: Page) {
  await page.goto('/login');
  await expect(page.locator('.MuiDialog-paper')).toBeVisible({ timeout: 8_000 });
}

const dialog = (page: Page) => page.locator('.MuiDialog-paper');

async function clickTab(page: Page, name: string) {
  await dialog(page)
    .locator('button:not([type="submit"])')
    .filter({ hasText: new RegExp(`^${name}$`, 'i') })
    .click();
}

test.describe('Registration', () => {
  const ts = () => Date.now().toString(36);

  test('registers new anon user successfully', async ({ page }) => {
    await openLoginDialog(page);
    await clickTab(page, 'Anon');

    const username = `${NEW_USER_PREFIX}${ts()}`;
    await dialog(page).locator('input[type="text"]').fill(username);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('TestPass@123');

    await dialog(page).locator('button[type="submit"]').click();

    await expect(page.locator('.MuiDialog-paper')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(username, { exact: false })).toBeVisible({ timeout: 8_000 });
  });

  test('shows validation error for mismatched passwords', async ({ page }) => {
    await openLoginDialog(page);
    await clickTab(page, 'Anon');

    await dialog(page).locator('input[type="text"]').fill(`${NEW_USER_PREFIX}${ts()}`);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('WrongPass@456');

    await dialog(page).locator('button[type="submit"]').click();

    await expect(dialog(page).getByText(/passwords do not match/i)).toBeVisible({ timeout: 5_000 });
  });

  test('shows error for duplicate username', async ({ page }) => {
    await openLoginDialog(page);
    await clickTab(page, 'Anon');

    await dialog(page).locator('input[type="text"]').fill(TEST_USER.username);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('TestPass@123');

    await dialog(page).locator('button[type="submit"]').click();

    await expect(dialog(page).locator('.MuiAlert-root')).toBeVisible({ timeout: 8_000 });
  });

  test('registers new email user and redirects to verification', async ({ page }) => {
    await openLoginDialog(page);
    await clickTab(page, 'Sign Up');

    const uniqueSuffix = ts();
    await dialog(page).locator('input[type="email"]').fill(`pw_em${uniqueSuffix}@test.local`);
    await dialog(page).locator('input[type="text"]').fill(`${NEW_USER_PREFIX}em${uniqueSuffix}`);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('TestPass@123');

    await page.route('https://cyoa.cafe/**', (route) => route.fulfill({ status: 200, body: '' }));

    await dialog(page).locator('button[type="submit"]').click();

    await expect(dialog(page).locator('.MuiAlert-root[severity="error"]')).not.toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('Login', () => {
  test('logs in with valid credentials', async ({ page }) => {
    await openLoginDialog(page);
    await dialog(page).locator('input[type="text"]').fill(TEST_USER.username);
    await dialog(page).locator('input[type="password"]').fill(TEST_USER.password);
    await dialog(page).locator('button[type="submit"]').click();

    await expect(page.locator('.MuiDialog-paper')).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(TEST_USER.username, { exact: false })).toBeVisible({ timeout: 8_000 });
  });

  test('shows error for wrong password', async ({ page }) => {
    await openLoginDialog(page);
    await dialog(page).locator('input[type="text"]').fill(TEST_USER.username);
    await dialog(page).locator('input[type="password"]').fill('WrongPassword!');
    await dialog(page).locator('button[type="submit"]').click();

    await expect(dialog(page).locator('.MuiAlert-root')).toBeVisible({ timeout: 8_000 });
  });

  test('shows error for non-existent user', async ({ page }) => {
    await openLoginDialog(page);
    await dialog(page).locator('input[type="text"]').fill('no_such_user_xyz_99');
    await dialog(page).locator('input[type="password"]').fill('SomePassword@1');
    await dialog(page).locator('button[type="submit"]').click();

    await expect(dialog(page).locator('.MuiAlert-root')).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('Logout', () => {
  test('logs out via user menu', async ({ page }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);

    await page.getByText(TEST_USER.username, { exact: false }).click();
    await page.getByRole('menuitem', { name: /logout/i }).click();

    await expect(
      page.locator('header').getByRole('button', { name: /login/i }),
    ).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('Password Recovery', () => {
  test('recovery page renders the form', async ({ page }) => {
    await page.goto('/recovery');
    const d = page.locator('.MuiDialog-paper');
    await expect(d).toBeVisible({ timeout: 8_000 });

    await expect(d.getByText(/reset password/i)).toBeVisible();
    await expect(d.locator('input[type="email"]')).toBeVisible();
    await expect(d.locator('button[type="submit"]')).toBeVisible();
  });

  test('submission with mocked turnstile shows success', async ({ page }) => {
    // Replace the Turnstile script with a fake that calls onSuccess immediately (sets
    // turnstileToken → enables submit).
    await page.route('**/turnstile/v0/api.js*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.turnstile = {
            render: function(container, params) {
              // Call the success callback immediately with a fake token
              setTimeout(function() {
                if (params && typeof params.callback === 'function') {
                  params.callback('fake-turnstile-token-for-tests');
                }
              }, 50);
              return 'fake-widget-id';
            },
            reset: function() {},
            remove: function() {},
            getResponse: function() { return 'fake-turnstile-token-for-tests'; },
          };
        `,
      }),
    );

    await page.route('/api/custom/verify-turnstile', (route) =>
      route.fulfill({ status: 200, json: { success: true } }),
    );

    await page.route('**/api/collections/users/request-password-reset', (route) =>
      route.fulfill({ status: 204, body: '' }),
    );

    await page.goto('/recovery');
    const d = page.locator('.MuiDialog-paper');
    await expect(d.locator('input[type="email"]')).toBeVisible({ timeout: 8_000 });

    await d.locator('input[type="email"]').fill('someuser@test.local');

    const submitBtn = d.locator('button[type="submit"]');
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    await expect(d.getByText(/recovery email sent/i)).toBeVisible({ timeout: 10_000 });
  });
});
