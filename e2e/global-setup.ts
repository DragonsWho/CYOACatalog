// Playwright global setup: copies the local PB DB (schema + tags), starts an ephemeral PocketBase,
// wipes user data, seeds users + one game. Collections missing from the local DB are created here
// as mirrors of PB/*.py scripts — the site repo must stay self-contained, and prod schema is
// applied by the author, never by tests.

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FullConfig } from '@playwright/test';

import {
  TEST_PB_PORT,
  TEST_BASE_URL,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  PB_TEST_DIR,
  PB_PID_FILE,
  TEST_USER,
  TEST_USER2,
  TEST_GAME_TITLE,
  TEST_GAME_ID_ENV,
} from './constants';

const PB_BINARY = path.join(process.cwd(), 'dist', 'serve');
const SOURCE_DB = path.join(process.cwd(), 'pb_data', 'data.db');
const ABS_TEST_DIR = path.join(process.cwd(), PB_TEST_DIR);
const ABS_PID_FILE = path.join(process.cwd(), PB_PID_FILE);

async function waitForServer(url: string, maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Test PocketBase server did not start within 30s at ${url}`);
}

async function getAdminToken(): Promise<string> {
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
  if (!res.ok) {
    throw new Error(`Superuser auth failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function listRecords(
  token: string,
  collection: string,
): Promise<{ id: string }[]> {
  const res = await fetch(
    `${TEST_BASE_URL}/api/collections/${collection}/records?perPage=500`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: { id: string }[] };
  return data.items ?? [];
}

async function clearCollection(token: string, collection: string): Promise<void> {
  const items = await listRecords(token, collection);
  for (const item of items) {
    await fetch(
      `${TEST_BASE_URL}/api/collections/${collection}/records/${item.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
  }
}

async function createTestUser(
  user: { username: string; password: string },
  adminToken: string,
): Promise<{ id: string }> {
  const res = await fetch(`${TEST_BASE_URL}/api/collections/users/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      username: user.username,
      password: user.password,
      passwordConfirm: user.password,
      name: user.username,
      verified: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create user "${user.username}": ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

async function getTagIds(adminToken: string, count: number = 5): Promise<string[]> {
  const res = await fetch(
    `${TEST_BASE_URL}/api/collections/tags/records?perPage=${count}&sort=created`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: { id: string }[] };
  return (data.items ?? []).map((t) => t.id);
}

async function createTestGame(
  adminToken: string,
  uploaderId: string,
  tagIds: string[],
): Promise<{ id: string }> {
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  const formData = new FormData();
  formData.append('title', TEST_GAME_TITLE);
  formData.append('description', 'A test game created by Playwright E2E tests.');
  formData.append('img_or_link', 'link');
  formData.append('iframe_url', 'https://example.com/test-cyoa');
  formData.append('uploader', uploaderId);
  formData.append(
    'image',
    new Blob([tinyPng], { type: 'image/png' }),
    'test-cover.png',
  );
  for (const tagId of tagIds) {
    formData.append('tags', tagId);
  }

  const res = await fetch(`${TEST_BASE_URL}/api/collections/games/records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: formData,
  });
  if (!res.ok) {
    throw new Error(`Failed to create test game: ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

async function ensureShoutboxCollection(adminToken: string): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminToken}`,
  };
  const existing = await fetch(
    `${TEST_BASE_URL}/api/collections/shoutbox_messages`,
    { headers },
  );
  if (existing.ok) return;

  const res = await fetch(`${TEST_BASE_URL}/api/collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'shoutbox_messages',
      type: 'base',
      listRule: '',
      viewRule: '',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: 'text', name: 'text', required: true, min: 0, max: 300 },
        {
          type: 'relation', name: 'user', collectionId: '_pb_users_auth_',
          cascadeDelete: false, minSelect: 0, maxSelect: 1, required: false,
        },
        { type: 'text', name: 'anon_key', min: 0, max: 32 },
        { type: 'select', name: 'kind', values: ['user', 'system'], maxSelect: 1, required: true },
        { type: 'json', name: 'event' },
        { type: 'json', name: 'reply' },
        { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
        { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create shoutbox collection: ${await res.text()}`);
  }
  console.log('  ✓ shoutbox_messages collection created (test DB only)');
}

// Mirror of PB/add_shoutbox_v2_schema.py (rooms, room link on messages, images, guest
// delete-passwords, blocks, per-room notify prefs). Without it the header chat opens on an empty
// feed. NOT mirrored on purpose: the private-room read rule (--rules step) — the fixture should
// look like prod, not ahead of it.
async function ensureShoutboxV2Schema(adminToken: string): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminToken}`,
  };

  const getCollection = async (name: string): Promise<any | null> => {
    const res = await fetch(`${TEST_BASE_URL}/api/collections/${name}`, { headers });
    return res.ok ? await res.json() : null;
  };
  const createCollection = async (body: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`${TEST_BASE_URL}/api/collections`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create ${body.name}: ${await res.text()}`);
    return await res.json();
  };

  const USERS = '_pb_users_auth_';
  const base = { required: false, hidden: false, presentable: false, system: false };
  const text = (name: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'text', name, min: 0, max: 0, pattern: '', ...base, ...extra });
  const rel = (name: string, collectionId: string, extra: Record<string, unknown> = {}) =>
    ({
      type: 'relation', name, collectionId, cascadeDelete: false,
      minSelect: 0, maxSelect: 1, ...base, ...extra,
    });
  const bool = (name: string) => ({ type: 'bool', name, ...base });
  const sel = (name: string, values: string[], maxSelect: number) =>
    ({ type: 'select', name, values, maxSelect, ...base });
  const autodate = (name: string, onUpdate: boolean) =>
    ({ type: 'autodate', name, onCreate: true, onUpdate, ...base });

  let channels = await getCollection('shoutbox_channels');
  if (!channels) {
    const visible = 'is_private = false || members.id ?= @request.auth.id';
    channels = await createCollection({
      name: 'shoutbox_channels',
      type: 'base',
      listRule: visible,
      viewRule: visible,
      createRule: null, updateRule: null, deleteRule: null,
      fields: [
        text('slug', { required: true, max: 32, pattern: '^[a-z0-9_-]+$' }),
        text('title', { required: true, max: 100 }),
        text('description', { max: 200 }),
        { type: 'number', name: 'sort', onlyInt: false, ...base },
        bool('enabled'),
        bool('is_private'),
        rel('members', USERS, { maxSelect: 2147483647 }),
        bool('is_dm'),
        rel('owner', USERS),
        sel('tags', ['sfw', 'nsfw', 'flood', 'wip', 'question'], 3),
        rel('likers', USERS, { maxSelect: 2147483647 }),
        text('discord_channel_id', { max: 32 }),
        autodate('created', false),
        autodate('updated', true),
      ],
      indexes: [
        'CREATE UNIQUE INDEX `idx_shoutbox_channels_slug` ON `shoutbox_channels` (`slug`)',
      ],
    });
    console.log('  ✓ shoutbox_channels collection created (test DB only)');
  } else {
    const have = new Set<string>(channels.fields.map((f: any) => f.name));
    const added: any[] = [];
    if (!have.has('tags')) added.push(sel('tags', ['sfw', 'nsfw', 'flood', 'wip', 'question'], 3));
    if (!have.has('likers')) added.push(rel('likers', USERS, { maxSelect: 2147483647 }));
    if (added.length > 0) {
      const res = await fetch(`${TEST_BASE_URL}/api/collections/${channels.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: [...channels.fields, ...added] }),
      });
      if (!res.ok) throw new Error(`Failed to add community fields: ${await res.text()}`);
      channels = await getCollection('shoutbox_channels');
      console.log('  ✓ shoutbox_channels: community fields added (test DB only)');
    }
  }

  const existingRooms: string[] = (await listRecords(adminToken, 'shoutbox_channels'))
    .map((r: any) => r.slug);
  const seedRooms = [
    { slug: 'general', title: 'General', sort: 10, enabled: true },
    { slug: 'suggestions', title: 'Suggestions', sort: 20, enabled: true },
  ];
  for (const room of seedRooms) {
    if (existingRooms.includes(room.slug)) continue;
    const res = await fetch(`${TEST_BASE_URL}/api/collections/shoutbox_channels/records`, {
      method: 'POST', headers, body: JSON.stringify(room),
    });
    if (!res.ok) throw new Error(`Failed to seed room ${room.slug}: ${await res.text()}`);
  }

  const messages = await getCollection('shoutbox_messages');
  if (messages) {
    const have = new Set<string>(messages.fields.map((f: any) => f.name));
    const added: any[] = [];
    if (!have.has('channel')) added.push(rel('channel', channels.id));
    if (!have.has('del_pass')) added.push(text('del_pass', { max: 128, hidden: true }));
    if (!have.has('author_ref')) added.push(rel('author_ref', USERS, { hidden: true }));
    if (!have.has('image')) {
      added.push({
        // 8 MB, paired with shoutImageMaxBytes (shoutbox_v2.go): WIP-CYOA pages are discussed as
        // images and 2 MB wasn't enough.
        type: 'file', name: 'image', maxSelect: 1, maxSize: 8 * 1024 * 1024,
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        thumbs: ['180x0', '360x0'], protected: false, ...base,
      });
    }
    if (!have.has('discord_msg_id')) added.push(text('discord_msg_id', { max: 32 }));
    if (!have.has('pinned')) added.push(bool('pinned'));
    if (!have.has('edited')) added.push(bool('edited'));

    // Field existed from a previous run: raise the cap anyway or the big-image test fails on an old
    // stand.
    const imageField = messages.fields.find((f: any) => f.name === 'image');
    if (imageField) imageField.maxSize = 8 * 1024 * 1024;

    const textField = messages.fields.find((f: any) => f.name === 'text');
    if (textField) {
      textField.required = false;
      textField.max = 1500;
    }
    const indexes: string[] = [...(messages.indexes ?? [])];
    if (!indexes.some((i) => i.includes('idx_shoutbox_channel'))) {
      indexes.push('CREATE INDEX `idx_shoutbox_channel` ON `shoutbox_messages` (`channel`, `created`)');
    }
    if (added.length > 0 || textField) {
      const res = await fetch(`${TEST_BASE_URL}/api/collections/${messages.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: [...messages.fields, ...added], indexes }),
      });
      if (!res.ok) {
        throw new Error(`Failed to add v2 fields to shoutbox_messages: ${await res.text()}`);
      }
    }
  }

  // Backend-only collections (push subscriptions, blocks, notify prefs), all rules null; /blocks
  // and /notify-prefs fail without them.
  if (!(await getCollection('push_subscriptions'))) {
    await createCollection({
      name: 'push_subscriptions', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        rel('user', USERS, { required: true, cascadeDelete: true }),
        text('endpoint', { required: true, max: 512 }),
        text('p256dh', { required: true, max: 128 }),
        text('auth', { required: true, max: 64 }),
        text('ua', { max: 256 }),
        text('mode', { max: 16 }),
        { type: 'date', name: 'last_ok', ...base },
        autodate('created', false),
      ],
      indexes: [
        'CREATE UNIQUE INDEX `idx_push_endpoint` ON `push_subscriptions` (`endpoint`)',
        'CREATE INDEX `idx_push_user` ON `push_subscriptions` (`user`)',
      ],
    });
  }
  if (!(await getCollection('shoutbox_blocks'))) {
    await createCollection({
      name: 'shoutbox_blocks', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        rel('user', USERS, { required: true, cascadeDelete: true }),
        rel('blocked', USERS, { required: true, cascadeDelete: true }),
        autodate('created', false),
      ],
      indexes: [
        'CREATE UNIQUE INDEX `idx_shoutbox_block_pair` ON `shoutbox_blocks` (`user`, `blocked`)',
      ],
    });
  }
  if (!(await getCollection('shoutbox_channel_prefs'))) {
    await createCollection({
      name: 'shoutbox_channel_prefs', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        rel('user', USERS, { required: true, cascadeDelete: true }),
        rel('channel', channels.id, { required: true, cascadeDelete: true }),
        text('mode', { required: true, max: 16 }),
        autodate('created', false),
        autodate('updated', true),
      ],
      indexes: [
        'CREATE UNIQUE INDEX `idx_shout_chanpref_pair` ON `shoutbox_channel_prefs` (`user`, `channel`)',
        'CREATE INDEX `idx_shout_chanpref_channel` ON `shoutbox_channel_prefs` (`channel`)',
      ],
    });
  }
  if (!(await getCollection('shoutbox_user_state'))) {
    await createCollection({
      name: 'shoutbox_user_state', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        rel('user', USERS, { required: true, cascadeDelete: true }),
        { type: 'json', name: 'notes', maxSize: 131072 },
        { type: 'json', name: 'pins', maxSize: 8192 },
        { type: 'json', name: 'reads', maxSize: 65536 },
        autodate('created', false),
        autodate('updated', true),
      ],
      indexes: [
        'CREATE UNIQUE INDEX `idx_shout_userstate_user` ON `shoutbox_user_state` (`user`)',
      ],
    });
  }
  console.log('  ✓ chat v2 schema ensured (rooms, message fields, blocks, prefs, user state)');
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  console.log('\n🧪 Playwright global setup — preparing test environment...');

  if (!fs.existsSync(PB_BINARY)) {
    throw new Error(
      `PocketBase binary not found at ${PB_BINARY}. ` +
        `Run 'make build' to build it first.`,
    );
  }

  if (!fs.existsSync(SOURCE_DB)) {
    throw new Error(
      `Source database not found at ${SOURCE_DB}. ` +
        `Run the dev server at least once to initialise PocketBase.`,
    );
  }

  if (fs.existsSync(ABS_TEST_DIR)) {
    fs.rmSync(ABS_TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(ABS_TEST_DIR, { recursive: true });

  fs.copyFileSync(SOURCE_DB, path.join(ABS_TEST_DIR, 'data.db'));
  console.log('  ✓ Database copied');

  execSync(
    `"${PB_BINARY}" superuser upsert "${TEST_ADMIN_EMAIL}" "${TEST_ADMIN_PASSWORD}" --dir "${ABS_TEST_DIR}"`,
    { stdio: 'pipe' },
  );
  console.log('  ✓ Test superuser created');

  const server = spawn(
    PB_BINARY,
    ['serve', '--dir', ABS_TEST_DIR, '--http', `127.0.0.1:${TEST_PB_PORT}`],
    {
      detached: false,
      stdio: process.env.PW_SERVER_VERBOSE ? 'inherit' : 'pipe',
      env: {
        ...process.env,
        // Turnstile off in tests; tests mock verify-turnstile via page.route().
        TURNSTILE_SECRET_KEY: '',
        SHOUTBOX_ENABLED: '1',
        SHOUTBOX_ANON_SALT: 'pw-test-salt',
        SHOUTBOX_WORD_FILTER: 'blockedword',
      },
    },
  );

  fs.writeFileSync(ABS_PID_FILE, String(server.pid));

  process.on('exit', () => {
    try {
      server.kill();
    } catch {
    }
  });

  await waitForServer(TEST_BASE_URL);
  console.log(`  ✓ Test server ready at ${TEST_BASE_URL}`);

  const adminToken = await getAdminToken();
  console.log('  ✓ Admin token obtained');

  await ensureShoutboxCollection(adminToken);
  await ensureShoutboxV2Schema(adminToken);

  console.log('  Cleaning previous test data...');
  await clearCollection(adminToken, 'shoutbox_messages');
  await clearCollection(adminToken, 'game_tag_votes');
  await clearCollection(adminToken, 'comments');
  await clearCollection(adminToken, 'game_relationships');
  await clearCollection(adminToken, 'games');
  await clearCollection(adminToken, 'users');
  console.log('  ✓ Collections cleared');

  console.log('  Seeding test users...');
  const user1 = await createTestUser(TEST_USER, adminToken);
  await createTestUser(TEST_USER2, adminToken);
  console.log(`  ✓ Test users created`);

  const tagIds = await getTagIds(adminToken, 5);
  if (tagIds.length === 0) {
    console.warn(
      '  ⚠ No tags found — test game will have no tags. ' +
        'Some tests may fail. Did you migrate tag data?',
    );
  }
  const game = await createTestGame(adminToken, user1.id, tagIds);
  process.env[TEST_GAME_ID_ENV] = game.id;
  console.log(`  ✓ Test game created (id=${game.id})`);

  console.log('✅ Test environment ready\n');
}
