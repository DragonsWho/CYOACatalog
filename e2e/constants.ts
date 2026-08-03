// e2e/constants.ts — Shared test constants

export const TEST_PB_PORT = 8099;
export const TEST_BASE_URL = `http://127.0.0.1:${TEST_PB_PORT}`;

export const TEST_ADMIN_EMAIL = 'test-admin@playwright.local';
export const TEST_ADMIN_PASSWORD = 'PlaywrightAdmin@123';

export const PB_TEST_DIR = 'pb_test_data';
export const PB_PID_FILE = `${PB_TEST_DIR}/test-server.pid`;

// Primary test user (used in most tests)
export const TEST_USER = {
  username: 'pw_testuser',
  password: 'TestUser@123',
};

// Secondary test user (for profile & multi-user tests)
export const TEST_USER2 = {
  username: 'pw_testuser2',
  password: 'TestUser2@123',
};

// Test game seeded before tests
export const TEST_GAME_TITLE = 'Playwright Test CYOA';
export const TEST_GAME_TITLE_ENV = 'TEST_GAME_TITLE';
export const TEST_GAME_ID_ENV = 'TEST_GAME_ID';

// Auth
export const NEW_USER_PREFIX = 'pw_new_';
