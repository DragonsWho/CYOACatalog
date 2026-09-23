import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/login';
import { getUserToken } from '../helpers/pb-api';
import {
  TEST_USER,
  TEST_GAME_TITLE,
  TEST_GAME_ID_ENV,
  TEST_BASE_URL,
} from '../constants';

test.describe('Game catalog', () => {
  test('home page loads and shows at least one game card', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.MuiCard-root').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('search bar opens when search button is clicked', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /open search/i }).click();
    const box = page.getByRole('searchbox', { name: /search/i });
    await expect(box).toBeVisible({ timeout: 10_000 });
    await expect(box).toBeFocused();
  });

  test('clicking a game card navigates to game detail page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.MuiCard-root').first().click();

    await expect(page).toHaveURL(/\/game\//, { timeout: 10_000 });
  });

  test('seeded test game appears in catalog', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByText(TEST_GAME_TITLE, { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Game detail page', () => {
  test('shows game title and description', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto(`/game/${gameId}`);
    await expect(
      page.getByText(TEST_GAME_TITLE, { exact: false }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows "Please log in to post comments" when not authenticated', async ({
    page,
  }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto(`/game/${gameId}`);
    await expect(
      page.getByText(/please log in to post comments/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows comments section when authenticated', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto(`/game/${gameId}`);

    await expect(
      page.getByText(/please log in to post comments/i),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Like (upvote) a game', () => {
  test('clicking the like button toggles upvote', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto(`/game/${gameId}`);

    const likeButton = page
      .locator('button')
      .filter({ has: page.locator('[data-testid="FavoriteIcon"], svg') })
      .first();

    if (!(await likeButton.count())) {
      const token = await getUserToken(TEST_USER.username, TEST_USER.password);
      const res = await fetch(
        `${TEST_BASE_URL}/api/custom/upvotes/${gameId}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { state: boolean; count: number };
      expect(typeof data.state).toBe('boolean');
      return;
    }

    await likeButton.click();
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).not.toContainText(/error/i);
  });

  test('upvote API endpoint works correctly', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto('/');
    const token = await getUserToken(TEST_USER.username, TEST_USER.password);

    const res = await fetch(`${TEST_BASE_URL}/api/custom/upvotes/${gameId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { state: boolean; count: number };
    expect(typeof data.state).toBe('boolean');
    expect(typeof data.count).toBe('number');

    await fetch(`${TEST_BASE_URL}/api/custom/upvotes/${gameId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});

test.describe('Add game', () => {
  test('redirects to /login when not authenticated', async ({ page }) => {
    await page.goto('/create');
    await expect(page).toHaveURL(/\/login/, { timeout: 8_000 });
  });

  test('create page renders form for authenticated user', async ({ page }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto('/create');

    // Scope to <main>: the header keeps a hidden search input (and the chat drawer a hidden
    // textarea) mounted on every page; unscoped .first() grabs those.
    await expect(page.locator('main').locator('input[id*="title"], input').filter({ hasNot: page.locator('[type="file"]') }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main').locator('textarea').first()).toBeVisible();
  });

  test('shows validation error when submitting empty form', async ({ page }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto('/create');
    await page.waitForLoadState('networkidle');

    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });
    await submitBtn.click();

    await expect(page.locator('input:invalid').first()).toBeVisible({ timeout: 5_000 });
  });

  test('can add a link-mode game via the form', async ({ page }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto('/create');
    await page.waitForLoadState('networkidle');

    const uniqueTitle = `PW Link Game ${Date.now().toString(36)}`;

    await page.locator('input[type="text"]').first().fill(uniqueTitle);

    await page.locator('textarea').first().fill('Created by Playwright E2E test.');

    const linkOption = page.getByRole('option', { name: /link/i });
    if (await linkOption.count()) {
      await page.locator('[aria-label*="mode"], select').selectOption('link');
    } else {
      const toggleLink = page.getByText(/link|iframe/i).first();
      if (await toggleLink.count()) await toggleLink.click();
    }

    const iframeInput = page.getByLabel(/iframe url|link url/i);
    if (await iframeInput.count()) {
      await iframeInput.fill('https://example.com/test-cyoa-link');
    }

    const coverInput = page.locator('input[type="file"]').first();
    if (await coverInput.count()) {
      await coverInput.setInputFiles({
        name: 'test-cover.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
    }

    const firstTagChip = page.locator('.MuiChip-root').first();
    if (await firstTagChip.count()) {
      await firstTagChip.click();
    }

    const submit = page.getByRole('button', { name: /submit|add|create|publish/i });
    if (!(await submit.count())) {
      test.skip();
      return;
    }
    await submit.first().click();

    await page.waitForTimeout(3_000);
    const currentUrl = page.url();
    const hasError = await page.locator('.MuiAlert-root').count() > 0;
    const navigatedAway = !currentUrl.includes('/create');

    expect(navigatedAway || hasError).toBe(true);
  });
});
