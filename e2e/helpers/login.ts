// Fast login: call PB auth from the browser context, write the token into localStorage exactly like
// the PB JS SDK's LocalAuthStore, then reload so React picks it up.

import type { Page } from '@playwright/test';
import { TEST_BASE_URL } from '../constants';

export interface Credentials {
  username: string;
  password: string;
}

export async function loginViaApi(page: Page, creds: Credentials): Promise<void> {
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

  await page.evaluate(({ token, record }) => {
    localStorage.setItem(
      'pocketbase_auth',
      JSON.stringify({ token, record }),
    );
  }, auth);

  await page.reload({ waitUntil: 'networkidle' });
}

export async function logoutViaApi(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('pocketbase_auth');
  });
  await page.reload({ waitUntil: 'networkidle' });
}
