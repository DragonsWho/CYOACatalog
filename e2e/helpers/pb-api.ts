// e2e/helpers/pb-api.ts — Direct PocketBase HTTP API helpers for tests

import { TEST_BASE_URL, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../constants';

/** Authenticate as the test superuser and return a bearer token. */
export async function getAdminToken(): Promise<string> {
  const res = await fetch(
    `${TEST_BASE_URL}/api/collections/_superusers/auth-with-password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: TEST_ADMIN_EMAIL,
        password: TEST_ADMIN_PASSWORD,
      }),
    },
  );
  if (!res.ok) throw new Error(`Admin auth failed: ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Authenticate as a regular user and return a bearer token. */
export async function getUserToken(
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(
    `${TEST_BASE_URL}/api/collections/users/auth-with-password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: username, password }),
    },
  );
  if (!res.ok) throw new Error(`User auth failed: ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Return the first N record IDs from a collection (admin-authenticated). */
export async function listRecordIds(
  token: string,
  collection: string,
  perPage = 10,
): Promise<string[]> {
  const res = await fetch(
    `${TEST_BASE_URL}/api/collections/${collection}/records?perPage=${perPage}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: { id: string }[] };
  return (data.items ?? []).map((r) => r.id);
}

/** Delete a record from a collection (admin-authenticated). */
export async function deleteRecord(
  token: string,
  collection: string,
  id: string,
): Promise<void> {
  await fetch(
    `${TEST_BASE_URL}/api/collections/${collection}/records/${id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

/** Create a comment via the custom endpoint (authenticated as user). */
export async function createComment(
  userToken: string,
  gameId: string,
  content: string,
  parentId?: string,
): Promise<{ id: string; comments_count: number }> {
  const res = await fetch(`${TEST_BASE_URL}/api/custom/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({ game_id: gameId, content, parent_id: parentId }),
  });
  if (!res.ok) throw new Error(`Create comment failed: ${await res.text()}`);
  return res.json() as Promise<{ id: string; comments_count: number }>;
}
