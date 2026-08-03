// e2e/helpers/login.ts — Fast UI-state login via PocketBase API
//
// Instead of navigating through the login dialog for every test, we call
// PocketBase's auth endpoint directly, then write the token into localStorage.
// This matches exactly how PocketBase JS SDK stores auth (LocalAuthStore).

import type { Page } from '@playwright/test';
import { TEST_BASE_URL } from '../constants';

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Login by calling the PocketBase API and writing the result into the page's
 * localStorage. After calling this, reload the page to let React pick up the
 * stored token.
 *
 * @param page  Playwright Page. Must already be navigated to the app origin.
 * @param creds Username + password
 */
export async function loginViaApi(page: Page, creds: Credentials): Promise<void> {
  // Call PocketBase auth endpoint from the browser context so the request
  // goes to the correct origin (same as localStorage).
  const auth = await page.evaluate(
    async ({ baseUrl, identity, password }) => {
      const res = await fetch(
        `${baseUrl}/api/collections/users/auth-with-password`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity, password }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Login failed (${res.status}): ${text}`);
      }
      return res.json() as Promise<{ token: string; record: unknown }>;
    },
    {
      baseUrl: TEST_BASE_URL,
      identity: creds.username,
      password: creds.password,
    },
  );

  // Write into localStorage the same way PocketBase JS SDK does
  await page.evaluate(({ token, record }) => {
    localStorage.setItem(
      'pocketbase_auth',
      JSON.stringify({ token, record }),
    );
  }, auth);

  // Reload so the React app picks up the stored auth
  await page.reload({ waitUntil: 'networkidle' });
}

/**
 * Clear the PocketBase auth from localStorage (equivalent to logout).
 */
export async function logoutViaApi(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('pocketbase_auth');
  });
  await page.reload({ waitUntil: 'networkidle' });
}
