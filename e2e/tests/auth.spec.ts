// e2e/tests/auth.spec.ts — Authentication flows
//
// Key notes about MUI TextField selectors:
//   • MUI adds " *" (thin-space + asterisk) to required field labels, so
//     getByLabel('Email') won't find a required TextField labelled "Email".
//   • We scope everything inside .MuiDialog-paper and use input[type=...].
//   • Tab buttons come BEFORE the form submit button in the DOM, so
//     dialog.getByRole('button', { name: 'Log In' }).first() = tab button,
//     dialog.locator('button[type="submit"]') = submit button.

import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/login';
import { TEST_USER, NEW_USER_PREFIX } from '../constants';

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

type Page = import('@playwright/test').Page;

/** Navigate to /login and wait for the MUI Dialog to appear. */
async function openLoginDialog(page: Page) {
  await page.goto('/login');
  await expect(page.locator('.MuiDialog-paper')).toBeVisible({ timeout: 8_000 });
}

/** Scoped handle to the open dialog. */
const dialog = (page: Page) => page.locator('.MuiDialog-paper');

/** Click a dialog tab (Log In / Sign Up / Anon). */
async function clickTab(page: Page, name: string) {
  // Tab buttons are HeaderTab components rendered before the form content;
  // they are NOT type="submit", just regular buttons.
  await dialog(page)
    .locator('button:not([type="submit"])')
    .filter({ hasText: new RegExp(`^${name}$`, 'i') })
    .click();
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

test.describe('Registration', () => {
  const ts = () => Date.now().toString(36);

  test('registers new anon user successfully', async ({ page }) => {
    await openLoginDialog(page);
    await clickTab(page, 'Anon');

    const username = `${NEW_USER_PREFIX}${ts()}`;
    // Anon form: 1 text input (username) + 2 password inputs
    await dialog(page).locator('input[type="text"]').fill(username);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('TestPass@123');

    await dialog(page).locator('button[type="submit"]').click();

    // Dialog closes and username appears in the header
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

    // TEST_USER.username already exists (seeded in globalSetup)
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
    // Email reg form: email + text(username) + 2 passwords
    await dialog(page).locator('input[type="email"]').fill(`pw_em${uniqueSuffix}@test.local`);
    await dialog(page).locator('input[type="text"]').fill(`${NEW_USER_PREFIX}em${uniqueSuffix}`);
    await dialog(page).locator('input[type="password"]').first().fill('TestPass@123');
    await dialog(page).locator('input[type="password"]').nth(1).fill('TestPass@123');

    // Intercept the redirect to cyoa.cafe so the test stays on our server
    await page.route('https://cyoa.cafe/**', (route) => route.fulfill({ status: 200, body: '' }));

    await dialog(page).locator('button[type="submit"]').click();

    // Either the dialog closes (redirect happened) or we get a network error alert.
    // In both cases there should be no PocketBase auth error.
    await expect(dialog(page).locator('.MuiAlert-root[severity="error"]')).not.toBeVisible({
      timeout: 10_000,
    });
  });
});

// --------------------------------------------------------------------------
// Login
// --------------------------------------------------------------------------

test.describe('Login', () => {
  test('logs in with valid credentials', async ({ page }) => {
    await openLoginDialog(page);
    // Login form: 1 text input (Email/Username) + 1 password
    await dialog(page).locator('input[type="text"]').fill(TEST_USER.username);
    await dialog(page).locator('input[type="password"]').fill(TEST_USER.password);
    await dialog(page).locator('button[type="submit"]').click();

    // Dialog closes and username appears in the header
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

// --------------------------------------------------------------------------
// Logout
// --------------------------------------------------------------------------

test.describe('Logout', () => {
  test('logs out via user menu', async ({ page }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);

    // The user menu button contains the username; click it
    await page.getByText(TEST_USER.username, { exact: false }).click();
    await page.getByRole('menuitem', { name: /logout/i }).click();

    // After logout the Login button reappears in the header
    await expect(
      page.locator('header').getByRole('button', { name: /login/i }),
    ).toBeVisible({ timeout: 8_000 });
  });
});

// --------------------------------------------------------------------------
// Password Recovery
// --------------------------------------------------------------------------

test.describe('Password Recovery', () => {
  test('recovery page renders the form', async ({ page }) => {
    await page.goto('/recovery');
    const d = page.locator('.MuiDialog-paper');
    await expect(d).toBeVisible({ timeout: 8_000 });

    // Header text
    await expect(d.getByText(/reset password/i)).toBeVisible();
    // Email input (type=email)
    await expect(d.locator('input[type="email"]')).toBeVisible();
    // Cloudflare Turnstile renders a visible widget (even if the challenge is blocked)
    await expect(d.locator('button[type="submit"]')).toBeVisible();
  });

  test('submission with mocked turnstile shows success', async ({ page }) => {
    // 1. Replace the Cloudflare Turnstile script with a fake that immediately
    //    calls onSuccess callback — this sets turnstileToken in React state
    //    so the submit button becomes enabled.
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

    // 2. Mock our own verify-turnstile endpoint
    await page.route('/api/custom/verify-turnstile', (route) =>
      route.fulfill({ status: 200, json: { success: true } }),
    );

    // 3. Mock PocketBase password-reset to avoid sending real emails
    await page.route('**/api/collections/users/request-password-reset', (route) =>
      route.fulfill({ status: 204, body: '' }),
    );

    await page.goto('/recovery');
    const d = page.locator('.MuiDialog-paper');
    await expect(d.locator('input[type="email"]')).toBeVisible({ timeout: 8_000 });

    await d.locator('input[type="email"]').fill('someuser@test.local');

    // Wait for the fake Turnstile to fire (50ms delay in our mock)
    // and enable the submit button
    const submitBtn = d.locator('button[type="submit"]');
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    await expect(d.getByText(/recovery email sent/i)).toBeVisible({ timeout: 10_000 });
  });
});
