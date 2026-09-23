import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/login';
import { TEST_USER } from '../constants';

const CONFIRMATION_PHRASE = 'manage account';

async function gotoProfile(page: import('@playwright/test').Page) {
  await page.goto('/');
  await loginViaApi(page, TEST_USER);
  await page.goto('/profile');
  await page.waitForLoadState('networkidle');
}

async function openAccountSettings(page: import('@playwright/test').Page) {
  const accordion = page.locator('.MuiAccordionSummary-root').filter({ hasText: /account management/i });

  if (await accordion.count()) {
    const expanded = await accordion.getAttribute('aria-expanded');
    if (expanded !== 'true') await accordion.click();
  }
}

async function unlockAccountSettings(page: import('@playwright/test').Page) {
  await openAccountSettings(page);

  const unlockBtn = page.getByRole('button', { name: /unlock/i });
  await expect(unlockBtn).toBeVisible({ timeout: 8_000 });
  await unlockBtn.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  await dialog.locator('input').fill(CONFIRMATION_PHRASE);
  await dialog.getByRole('button', { name: /unlock/i }).click();

  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

test.describe('Profile page', () => {
  test('redirects to /login when not authenticated', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/, { timeout: 8_000 });
  });

  test('shows the profile page when authenticated', async ({ page }) => {
    await gotoProfile(page);
    await expect(
      page.getByText(/profile|preferences|account/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows "Restricted Area" lock before unlocking account settings', async ({
    page,
  }) => {
    await gotoProfile(page);
    await openAccountSettings(page);

    await expect(page.getByText(/restricted area/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /unlock/i })).toBeVisible();
  });

  test('unlocking requires the correct confirmation phrase', async ({ page }) => {
    await gotoProfile(page);
    await openAccountSettings(page);

    const unlockBtn = page.getByRole('button', { name: /unlock/i });
    await unlockBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('input').fill('wrong phrase');
    await dialog.getByRole('button', { name: /unlock/i }).click();

    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await expect(dialog.locator('input')).toHaveAttribute('aria-invalid', 'true');
  });

  test('unlocking with correct phrase reveals account forms', async ({ page }) => {
    await gotoProfile(page);
    await unlockAccountSettings(page);

    await expect(page.getByText(/profile information/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/change password/i)).toBeVisible();
  });

  test('updates username and display name', async ({ page }) => {
    await gotoProfile(page);
    await unlockAccountSettings(page);

    const usernameField = page.locator('[name="username"]');
    const nameField = page.locator('[name="name"]');

    await expect(usernameField).toBeVisible({ timeout: 5_000 });

    const newDisplayName = `PW Display ${Date.now().toString(36)}`;
    await nameField.fill(newDisplayName);

    await page.getByRole('button', { name: /update profile/i }).click();

    await expect(
      page.getByText(/profile updated successfully/i),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('shows error when changing password with wrong current password', async ({
    page,
  }) => {
    await gotoProfile(page);
    await unlockAccountSettings(page);

    const oldPwField = page.locator('[name="oldPassword"]');
    const newPwField = page.locator('[name="password"]');
    const confirmPwField = page.locator('[name="passwordConfirm"]');

    await expect(oldPwField).toBeVisible({ timeout: 5_000 });

    await oldPwField.fill('WrongCurrentPass@1');
    await newPwField.fill('NewTestPass@456');
    await confirmPwField.fill('NewTestPass@456');

    await page.getByRole('button', { name: /set password/i }).click();

    await expect(page.locator('.MuiAlert-root')).toBeVisible({ timeout: 8_000 });
  });

  test('blocked tags autocomplete is visible', async ({ page }) => {
    await gotoProfile(page);

    await expect(
      page.getByLabel(/select tags to block/i),
    ).toBeVisible({ timeout: 10_000 });
  });
});
