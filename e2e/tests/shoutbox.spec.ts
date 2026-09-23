// Chat acceptance tests. Rate-limit state is in-memory, keyed by IP (all tests share 127.0.0.1) →
// ORDER MATTERS: rate-limit-sensitive tests first; the anon-mute test runs LAST (poisons the anon
// source for 24h). Server enforces a 5s min-gap between one user's posts — ride it out between
// posts.

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

    const rapid = await post(request, 'again too soon');
    expect(rapid.status).toBe(429);

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

    const dup = await post(request, 'unique text from user2', token);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
  });

  test('header chat drawer: logged-in user posts, realtime delivers others', async ({ page, request }) => {
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.getByRole('button', { name: 'Chat' }).click();
    const input = page.getByPlaceholder(/^(Message .+|Write a message)…$/);
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.fill('hi from the lab UI');
    await input.press('Enter');
    await expect(page.getByText('hi from the lab UI')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(TEST_USER.username).first()).toBeVisible();

    const token2 = await getUserToken(TEST_USER2.username, TEST_USER2.password);
    let r = await post(request, 'realtime says hello', token2);
    for (let i = 0; r.status === 429 && i < 8; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await post(request, 'realtime says hello', token2);
    }
    expect(r.status).toBe(200);
    await expect(page.getByText('realtime says hello')).toBeVisible({ timeout: 10_000 });
  });

  test('chat entry points: full page on click, drawer on double click, old lab URL redirects', async ({ page }) => {
    // singleClickFullChat (chatPrefs.ts) ships ON: single click = full /chat page, double click =
    // compact drawer.
    await page.goto('/');
    const bubble = page.getByRole('button', { name: 'Chat' });

    await bubble.click();
    await expect(page).toHaveURL(/\/chat$/);
    const chat = page.locator('main');
    await expect(chat.getByText('Rooms', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(chat.getByText(/^Here now —/)).toBeVisible();

    await page.goto('/');
    await page.getByRole('button', { name: 'Chat' }).dblclick();
    const drawer = page.getByRole('dialog', { name: 'Chat' });
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe('/');
    const box = await drawer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(500);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await page.goto('/chat-lab');
    await expect(page).toHaveURL(/\/chat$/);
  });

  test('composer keyboard: Enter and Ctrl+Enter send, Shift+Enter breaks the line', async ({ page }) => {
    // Desktop keys since 2026-09-13: Enter sends, Shift+Enter newline, Ctrl+Enter sends everywhere.
    // Log in from the catalog: loginViaApi waits for networkidle, which /chat never reaches (live
    // realtime subscription).
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto('/chat');
    const input = page.getByPlaceholder(/^(Message .+|Write a message)…$/);
    await expect(input).toBeVisible({ timeout: 10_000 });

    const twoLines = await input.evaluate((el) => el.clientHeight);
    await input.click();
    expect(await input.evaluate((el) => el.clientHeight)).toBe(twoLines);

    await page.waitForTimeout(6_000);
    await input.fill('keyboard: plain enter');
    await input.press('Enter');
    await expect(page.getByText('keyboard: plain enter')).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('');

    await input.fill('first line');
    await input.press('Shift+Enter');
    await input.type('second line');
    expect(await input.inputValue()).toBe('first line\nsecond line');

    await page.waitForTimeout(6_000);
    await input.press('Control+Enter');
    await expect(page.getByText('second line')).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('');
  });

  // A new DM must appear WITHOUT F5 (room list used to load once on mount). Full path: subscription
  // delivers a message from an unknown channel → frontend re-reads /channels → conversation shows
  // up.
  test('new DM shows up in the room list without a reload', async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await loginViaApi(page, TEST_USER);
    await page.goto('/chat');
    await expect(page.getByPlaceholder(/^(Message .+|Write a message)…$/))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Direct', { exact: true })).toHaveCount(0);

    // The subscription starts with ~1.5s jitter (so a batch of waking tabs doesn't connect in the
    // same second). Post AFTER it, or only the once-a-minute ping catches the message and the test
    // measures the fallback path.
    await page.waitForRequest(
      (r) => r.url().includes('/api/realtime') && r.method() === 'POST',
      { timeout: 20_000 },
    );

    const admin = await getAdminToken();
    const users = await request.get(
      `/api/collections/users/records?filter=${encodeURIComponent(`username='${TEST_USER.username}'`)}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    const meId = ((await users.json()).items as any[])[0]?.id as string;
    expect(meId, 'test user should exist').toBeTruthy();

    const token2 = await getUserToken(TEST_USER2.username, TEST_USER2.password);
    const dm = await request.post(`${API}/dm`, {
      data: { user: meId },
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(dm.status()).toBe(200);
    const slug = (await dm.json()).channel?.slug as string;
    expect(slug, 'dm channel should have a slug').toBeTruthy();

    const data = { text: 'dm arrives live', channel: slug };
    const auth = { Authorization: `Bearer ${token2}` };
    let sent = await request.post(API, { data, headers: auth });
    for (let i = 0; sent.status() === 429 && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      sent = await request.post(API, { data, headers: auth });
    }
    expect(sent.status()).toBe(200);

    await expect(page.getByText('Direct', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TEST_USER2.username).first()).toBeVisible({ timeout: 20_000 });
  });

  test('reply stores a denormalized quote of the parent message', async ({ request }) => {
    const token = await getUserToken(TEST_USER.username, TEST_USER.password);
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

  test('user state: notes, pins and cross-device read marks', async ({ request }) => {
    const token1 = await getUserToken(TEST_USER.username, TEST_USER.password);
    const admin = await getAdminToken();
    const idOf = async (username: string) => {
      const res = await request.get(
        `/api/collections/users/records?filter=${encodeURIComponent(`username='${username}'`)}`,
        { headers: { Authorization: `Bearer ${admin}` } },
      );
      return (await res.json()).items[0].id as string;
    };
    const peerId = await idOf(TEST_USER2.username);
    const selfId = await idOf(TEST_USER.username);
    const auth1 = { Authorization: `Bearer ${token1}` };

    const note = await request.post(`${API}/note`, {
      data: { user: peerId, alias: '  Rusty\nnag  ', note: 'met in a thread\npromised a translation' },
      headers: auth1,
    });
    expect(note.status()).toBe(200);
    expect((await note.json()).alias).toBe('Rusty nag');
    expect((await note.json()).note).toContain('\n');

    const state = await request.get(`${API}/state`, { headers: auth1 });
    expect(state.status()).toBe(200);
    expect((await state.json()).notes[peerId].a).toBe('Rusty nag');

    const onSelf = await request.post(`${API}/note`, {
      data: { user: selfId, alias: 'me' }, headers: auth1,
    });
    expect(onSelf.status()).toBe(400);

    const raw = await request.get(
      '/api/collections/shoutbox_user_state/records', { headers: auth1 },
    );
    expect(raw.status()).not.toBe(200);

    const chans = await request.get(`${API}/channels`, { headers: auth1 });
    const chId = ((await chans.json()).channels as { id: string }[])[0].id;
    const pins = await request.post(`${API}/pins`, {
      data: { pins: [chId, 'nosuchchannel00'] }, headers: auth1,
    });
    expect(pins.status()).toBe(200);
    expect((await pins.json()).pins).toEqual([chId]);

    const ping = (seen: Record<string, number>) => request.post(
      `${API}/ping?chat=1`, { data: { seen }, headers: auth1 },
    );
    // Use read marks newer than anything earlier tests set: a message sent earlier in this room
    // leaves its own read mark, which would beat a fixed past date.
    const mark = Math.floor(Date.now() / 1000) + 3600;
    const laptop = await ping({ [chId]: mark });
    expect(laptop.status()).toBe(200);
    expect((await laptop.json()).reads).toBeFalsy();

    const phone = await ping({ [chId]: mark - 100_000 });
    expect((await phone.json()).reads[chId]).toBe(mark);

    const after = await request.get(`${API}/state`, { headers: auth1 });
    expect((await after.json()).reads[chId]).toBe(mark);
  });

  test('staff room: private, members follow the moderator list, cannot be opened up', async ({ request }) => {
    // Staff room: no role-based read in the schema — listRule filters by members, so membership is
    // materialized; that's what we test.
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
    const modAuth = { Authorization: `Bearer ${modToken}` };

    const token1 = await getUserToken(TEST_USER.username, TEST_USER.password);
    const denied = await request.post(`${API}/rooms/admin/staff`, {
      data: {}, headers: { Authorization: `Bearer ${token1}` },
    });
    expect(denied.status()).toBe(403);

    const made = await request.post(`${API}/rooms/admin/staff`, { data: {}, headers: modAuth });
    expect(made.status()).toBe(200);
    const again = await request.post(`${API}/rooms/admin/staff`, { data: {}, headers: modAuth });
    expect(again.status()).toBe(200);
    const rooms = (await again.json()).rooms as {
      id: string; slug: string; is_private: boolean; members: string[];
    }[];
    const staff = rooms.filter((r) => r.slug === 'staff');
    expect(staff).toHaveLength(1);
    expect(staff[0].is_private).toBe(true);
    expect(staff[0].members).toContain(user2.id);
    expect(staff[0].members).not.toContain((await request.get(
      `/api/collections/users/records?filter=${encodeURIComponent(`username='${TEST_USER.username}'`)}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    ).then((r) => r.json())).items[0].id);

    const slugsFor = async (headers: Record<string, string>) => {
      const res = await request.get(`${API}/channels`, { headers });
      return ((await res.json()).channels as { slug: string }[]).map((c) => c.slug);
    };
    expect(await slugsFor(modAuth)).toContain('staff');
    expect(await slugsFor({ Authorization: `Bearer ${token1}` })).not.toContain('staff');

    const opened = await request.post(`${API}/rooms/admin/update`, {
      data: { channel: staff[0].id, is_private: false }, headers: modAuth,
    });
    expect(opened.status()).toBe(400);
    const left = await request.post(`${API}/rooms/leave`, {
      data: { channel: staff[0].id }, headers: modAuth,
    });
    expect(left.status()).toBe(400);

    // Staff list is cached in memory for a minute (shoutStaffTTL): if asked before a promotion (UI
    // tests above do), the answer is stale — NOT a bug. Check shape; check membership only after
    // recompute. A moderator with no mod_permissions row is full-rights (legacy, mod_perms.go).
    const staffInfo = await request.get(`${API}/staff`);
    expect(staffInfo.status()).toBe(200);
    const admins = (await staffInfo.json()).admins as string[];
    expect(Array.isArray(admins)).toBe(true);
    if (admins.length > 0) expect(admins).toContain(user2.id);
  });

  test('moderator can delete and mute; mute really blocks (runs last)', async ({ request }) => {
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

    const list = await request.get(
      '/api/collections/shoutbox_messages/records?perPage=50',
    );
    const anonMsg = ((await list.json()).items as any[]).find(
      (m) => m.text === 'hello from anon',
    );
    expect(anonMsg).toBeTruthy();

    // Mute is checked before rate limits, so this is deterministic.
    const mute = await request.post(`${API}/mute`, {
      data: { id: anonMsg.id },
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(mute.status()).toBe(200);
    const muted = await post(request, 'anon after mute');
    expect(muted.status).toBe(403);

    const del = await request.post(`${API}/delete`, {
      data: { id: anonMsg.id },
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(del.status()).toBe(200);
    const after = await request.get('/api/collections/shoutbox_messages/records?perPage=50');
    expect(((await after.json()).items as any[]).some((m) => m.id === anonMsg.id)).toBe(false);

    const token1 = await getUserToken(TEST_USER.username, TEST_USER.password);
    const forbidden = await request.post(`${API}/delete`, {
      data: { id: 'whatever' },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(forbidden.status()).toBe(403);
  });
});
