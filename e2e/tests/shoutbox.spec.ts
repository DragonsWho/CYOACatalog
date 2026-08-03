// e2e/tests/shoutbox.spec.ts — Shoutbox (site mini-chat) acceptance tests.
// Spec: wiki/components/shoutbox-spec.md §10 (workbench repo).
//
// Rate-limit state is in-memory and keyed by IP (all tests share 127.0.0.1),
// so ordering matters: tests that must NOT be rate-limited run first, the
// anon-mute test runs LAST (it poisons the anon source for 24h).

import { test, expect } from '@playwright/test';
import { TEST_USER, TEST_USER2 } from '../constants';
import { getAdminToken, getUserToken } from '../helpers/pb-api';
import { loginViaApi } from '../helpers/login';

const API = '/api/custom/shoutbox';

async function post(
  request: any,
  text: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const res = await request.post(API, {
    data: { text },
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

test.describe('shoutbox', () => {
  test('config reports enabled', async ({ request }) => {
    const res = await request.get(`${API}/config`);
    expect(res.status()).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });

  test('game seeding produced a system message with a working link payload', async ({ request }) => {
    const res = await request.get(
      '/api/collections/shoutbox_messages/records?perPage=50',
    );
    expect(res.status()).toBe(200);
    const items = (await res.json()).items as any[];
    const sys = items.find((m) => m.kind === 'system' && m.event?.type === 'new_game');
    expect(sys, 'seeded test game should have announced itself').toBeTruthy();
    expect(sys.event.games[0].id).toBe(process.env.TEST_GAME_ID);
  });

  test('anon can post; second rapid post is rate-limited; links rejected', async ({ request }) => {
    const first = await post(request, 'hello from anon');
    expect(first.status).toBe(200);

    // Same source, different text, within the 15s window → 429.
    const rapid = await post(request, 'again too soon');
    expect(rapid.status).toBe(429);

    // URL check happens before rate-limiting, so this is deterministic.
    const link = await post(request, 'check https://spam.example');
    expect(link.status).toBe(400);
    expect(link.body.message).toContain('logged-in');
  });

  test('word filter rejects, duplicate is silently swallowed', async ({ request }) => {
    const token = await getUserToken(TEST_USER2.username, TEST_USER2.password);
    const bad = await post(request, 'you are a blockedword sir', token);
    expect(bad.status).toBe(400);

    const ok = await post(request, 'unique text from user2', token);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBeTruthy();

    // Same text, same source → 200 but no new record.
    const dup = await post(request, 'unique text from user2', token);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
  });

  test('header chat drawer: logged-in user posts, realtime delivers others', async ({ page, request }) => {
    // The chat bubble lives in the site header (the /shout-lab bench is gone), so
    // this exercises the real production flow straight from the catalog page.
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.getByRole('button', { name: 'Chat' }).click();
    const input = page.getByPlaceholder('Say something…');
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.fill('hi from the lab UI');
    await input.press('Enter');
    await expect(page.getByText('hi from the lab UI')).toBeVisible({ timeout: 5_000 });
    // Own name shown next to the message.
    await expect(page.getByText(TEST_USER.username).first()).toBeVisible();

    // Another user posts via API → arrives over the PB realtime subscription.
    // user2 posted in the previous test, so ride out its 5s min-gap window.
    const token2 = await getUserToken(TEST_USER2.username, TEST_USER2.password);
    let r = await post(request, 'realtime says hello', token2);
    for (let i = 0; r.status === 429 && i < 8; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await post(request, 'realtime says hello', token2);
    }
    expect(r.status).toBe(200);
    await expect(page.getByText('realtime says hello')).toBeVisible({ timeout: 10_000 });
  });

  test('reply stores a denormalized quote of the parent message', async ({ request }) => {
    const token = await getUserToken(TEST_USER.username, TEST_USER.password);
    // user1 posted earlier; ride out the 5s min-gap on each post.
    const postRetry = async (text: string, replyTo?: string) => {
      const data = replyTo ? { text, reply_to: replyTo } : { text };
      let res = await request.post(API, { data, headers: { Authorization: `Bearer ${token}` } });
      for (let i = 0; res.status() === 429 && i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        res = await request.post(API, { data, headers: { Authorization: `Bearer ${token}` } });
      }
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };

    const parent = await postRetry('parent message for reply');
    expect(parent.status).toBe(200);
    const child = await postRetry('a reply to it', parent.body.id);
    expect(child.status).toBe(200);

    const list = await request.get('/api/collections/shoutbox_messages/records?perPage=50');
    const rec = ((await list.json()).items as any[]).find((m) => m.id === child.body.id);
    expect(rec, 'reply message should exist').toBeTruthy();
    expect(rec.reply?.id).toBe(parent.body.id);
    expect(rec.reply?.text).toBe('parent message for reply');
  });

  test('moderator can delete and mute; mute really blocks (runs last)', async ({ request }) => {
    // Promote user2 to moderator for this test.
    const admin = await getAdminToken();
    const users = await request.get(
      `/api/collections/users/records?filter=${encodeURIComponent(`username='${TEST_USER2.username}'`)}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    const user2 = (await users.json()).items[0];
    await request.patch(`/api/collections/users/records/${user2.id}`, {
      data: { isModerator: true },
      headers: { Authorization: `Bearer ${admin}` },
    });
    const modToken = await getUserToken(TEST_USER2.username, TEST_USER2.password);

    // Find the anon message posted earlier.
    const list = await request.get(
      '/api/collections/shoutbox_messages/records?perPage=50',
    );
    const anonMsg = ((await list.json()).items as any[]).find(
      (m) => m.text === 'hello from anon',
    );
    expect(anonMsg).toBeTruthy();

    // Mute the anon source, then the anon tries to post → 403 (mute is
    // checked before rate limits, so this is deterministic).
    const mute = await request.post(`${API}/mute`, {
      data: { id: anonMsg.id },
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(mute.status()).toBe(200);
    const muted = await post(request, 'anon after mute');
    expect(muted.status).toBe(403);

    // Delete the message — it disappears from the public list.
    const del = await request.post(`${API}/delete`, {
      data: { id: anonMsg.id },
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(del.status()).toBe(200);
    const after = await request.get('/api/collections/shoutbox_messages/records?perPage=50');
    expect(((await after.json()).items as any[]).some((m) => m.id === anonMsg.id)).toBe(false);

    // Non-moderator cannot delete.
    const token1 = await getUserToken(TEST_USER.username, TEST_USER.password);
    const forbidden = await request.post(`${API}/delete`, {
      data: { id: 'whatever' },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(forbidden.status()).toBe(403);
  });
});
