// e2e/global-setup.ts — Start test PocketBase instance and seed data
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

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function waitForServer(url: string, maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
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
  // Use admin token to bypass any collection rules
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
      // Mark as verified so auth works without email confirmation
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
  // Minimal valid 1×1 transparent PNG
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

// Mirror of PB/create_shoutbox_collection.py (schema source of truth for
// review); duplicated here because the site repo must stay self-contained.
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

// --------------------------------------------------------------------------
// Global setup
// --------------------------------------------------------------------------

export default async function globalSetup(_config: FullConfig): Promise<void> {
  console.log('\n🧪 Playwright global setup — preparing test environment...');

  // 1. Verify binary exists
  if (!fs.existsSync(PB_BINARY)) {
    throw new Error(
      `PocketBase binary not found at ${PB_BINARY}. ` +
        `Run 'make build' to build it first.`,
    );
  }

  // 2. Verify source database exists
  if (!fs.existsSync(SOURCE_DB)) {
    throw new Error(
      `Source database not found at ${SOURCE_DB}. ` +
        `Run the dev server at least once to initialise PocketBase.`,
    );
  }

  // 3. Reset test data directory
  if (fs.existsSync(ABS_TEST_DIR)) {
    fs.rmSync(ABS_TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(ABS_TEST_DIR, { recursive: true });

  // 4. Copy database (brings schema + existing tags/categories; data wiped below)
  fs.copyFileSync(SOURCE_DB, path.join(ABS_TEST_DIR, 'data.db'));
  console.log('  ✓ Database copied');

  // 5. Create a dedicated test superuser via CLI (server must be stopped)
  execSync(
    `"${PB_BINARY}" superuser upsert "${TEST_ADMIN_EMAIL}" "${TEST_ADMIN_PASSWORD}" --dir "${ABS_TEST_DIR}"`,
    { stdio: 'pipe' },
  );
  console.log('  ✓ Test superuser created');

  // 6. Start test PocketBase server
  const server = spawn(
    PB_BINARY,
    ['serve', '--dir', ABS_TEST_DIR, '--http', `127.0.0.1:${TEST_PB_PORT}`],
    {
      detached: false,
      stdio: process.env.PW_SERVER_VERBOSE ? 'inherit' : 'pipe',
      env: {
        ...process.env,
        // Disable Turnstile in test environment so recovery tests work.
        // The verify-turnstile endpoint returns error when key is missing,
        // but tests mock that endpoint via page.route().
        TURNSTILE_SECRET_KEY: '',
        // Shoutbox is feature-flagged; the ephemeral test instance turns it on.
        SHOUTBOX_ENABLED: '1',
        SHOUTBOX_ANON_SALT: 'pw-test-salt',
        SHOUTBOX_WORD_FILTER: 'blockedword',
      },
    },
  );

  // Store PID for teardown
  fs.writeFileSync(ABS_PID_FILE, String(server.pid));

  // Clean up if setup is interrupted
  process.on('exit', () => {
    try {
      server.kill();
    } catch {
      /* ignore */
    }
  });

  // 7. Wait for server to accept connections
  await waitForServer(TEST_BASE_URL);
  console.log(`  ✓ Test server ready at ${TEST_BASE_URL}`);

  // 8. Authenticate as superuser
  const adminToken = await getAdminToken();
  console.log('  ✓ Admin token obtained');

  // 8b. Ensure the shoutbox collection exists in the EPHEMERAL test DB.
  // The prod/local schema is created separately after author review
  // (PB/create_shoutbox_collection.py); tests must not depend on that.
  await ensureShoutboxCollection(adminToken);

  // 9. Clear all user-generated data (keep tags/tag_categories/authors)
  console.log('  Cleaning previous test data...');
  await clearCollection(adminToken, 'shoutbox_messages');
  await clearCollection(adminToken, 'game_tag_votes');
  await clearCollection(adminToken, 'comments');
  await clearCollection(adminToken, 'game_relationships');
  await clearCollection(adminToken, 'games');
  await clearCollection(adminToken, 'users');
  console.log('  ✓ Collections cleared');

  // 10. Seed test users
  console.log('  Seeding test users...');
  const user1 = await createTestUser(TEST_USER, adminToken);
  await createTestUser(TEST_USER2, adminToken);
  console.log(`  ✓ Test users created`);

  // 11. Seed one test game (for catalog/like/comment tests)
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
