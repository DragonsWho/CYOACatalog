// e2e/tests/comments.spec.ts — Add, edit, and delete comments
//
// Custom MUI comment thread DOM (src/components/CyoaPage/Comments):
//   comment / reply / edit input : textarea[data-testid="comment-input"]
//   submit button                : button[data-testid="comment-submit"]  (label Comment/Reply/Save)
//   a single comment row         : [data-testid="comment"] (with data-comment-id)
//   per-comment actions          : buttons with text Reply / Edit / Delete (then Yes/No to confirm)

import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/login';
import { getUserToken, createComment } from '../helpers/pb-api';
import { TEST_USER, TEST_GAME_ID_ENV, TEST_BASE_URL } from '../constants';

type Page = import('@playwright/test').Page;
type Locator = import('@playwright/test').Locator;

async function gotoGamePage(page: Page) {
  const gameId = process.env[TEST_GAME_ID_ENV];
  if (!gameId) test.skip();

  await page.goto('/');
  await loginViaApi(page, TEST_USER);
  await page.goto(`/game/${gameId}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

/** The top-level new-comment input (the first one on the page). */
const newCommentInput = (page: Page) => page.getByTestId('comment-input').first();
const newCommentSubmit = (page: Page) => page.getByTestId('comment-submit').first();

/** The comment row containing the given text. */
const commentWithText = (page: Page, text: string): Locator =>
  page.getByTestId('comment').filter({ hasText: text }).last();

async function postTopLevelComment(page: Page, text: string) {
  await expect(newCommentInput(page)).toBeVisible({ timeout: 10_000 });
  await newCommentInput(page).fill(text);
  await newCommentSubmit(page).click();
  await expect(page.getByText(text, { exact: false })).toBeVisible({ timeout: 10_000 });
}

test.describe('Comments', () => {
  test('comment input is visible when logged in', async ({ page }) => {
    await gotoGamePage(page);
    await expect(newCommentInput(page)).toBeVisible({ timeout: 10_000 });
  });

  test('adds a new comment', async ({ page }) => {
    await gotoGamePage(page);
    await postTopLevelComment(page, `Playwright comment ${Date.now()}`);
  });

  test('adds a comment via API (direct)', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    await page.goto('/');
    const token = await getUserToken(TEST_USER.username, TEST_USER.password);
    const content = `API comment ${Date.now()}`;
    const result = await createComment(token, gameId!, content);

    expect(result.id).toBeTruthy();
    expect(result.comments_count).toBeGreaterThanOrEqual(1);
  });

  test('replies to a comment (nested thread)', async ({ page }) => {
    await gotoGamePage(page);

    const parentText = `Parent ${Date.now()}`;
    await postTopLevelComment(page, parentText);

    const replyText = `Reply ${Date.now()}`;
    const parent = commentWithText(page, parentText);
    await parent.getByRole('button', { name: /^reply$/i }).first().click();

    // The reply form's textarea is the one inside the parent comment row.
    const replyInput = parent.getByTestId('comment-input').first();
    await replyInput.fill(replyText);
    await parent.getByTestId('comment-submit').first().click();

    await expect(page.getByText(replyText, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test('deletes own comment', async ({ page }) => {
    await gotoGamePage(page);

    const text = `To delete ${Date.now()}`;
    await postTopLevelComment(page, text);

    const comment = commentWithText(page, text);
    await comment.getByRole('button', { name: /^delete$/i }).first().click();
    // Inline confirm: "Delete?  Yes  No"
    await comment.getByRole('button', { name: /^yes$/i }).first().click();

    await expect(page.getByText(text, { exact: true })).not.toBeVisible({ timeout: 8_000 });
  });

  test('deletes own comment via API fallback', async ({ page }) => {
    const gameId = process.env[TEST_GAME_ID_ENV];
    if (!gameId) test.skip();

    const token = await getUserToken(TEST_USER.username, TEST_USER.password);
    const content = `API del comment ${Date.now()}`;
    const { id: commentId } = await createComment(token, gameId!, content);

    const res = await fetch(
      `${TEST_BASE_URL}/api/collections/comments/records/${commentId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.ok).toBe(true);

    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto(`/game/${gameId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(content, { exact: false })).not.toBeVisible({ timeout: 8_000 });
  });

  test('edits own comment', async ({ page }) => {
    await gotoGamePage(page);

    const originalText = `Original ${Date.now()}`;
    await postTopLevelComment(page, originalText);

    const comment = commentWithText(page, originalText);
    await comment.getByRole('button', { name: /^edit$/i }).first().click();

    const updatedText = `Updated ${Date.now()}`;
    const editInput = comment.getByTestId('comment-input').first();
    await editInput.fill(updatedText);
    await comment.getByTestId('comment-submit').first().click();

    await expect(page.getByText(updatedText, { exact: false })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(originalText, { exact: true })).not.toBeVisible();
  });
});
