// e2e/global-teardown.ts — Stop test PocketBase instance
import * as fs from 'fs';
import * as path from 'path';
import type { FullConfig } from '@playwright/test';
import { PB_PID_FILE, PB_TEST_DIR } from './constants';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const pidFile = path.join(process.cwd(), PB_PID_FILE);

  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`\n🧹 Test server (pid=${pid}) stopped`);
    } catch (err) {
      // Process might have already exited
      console.warn(`  Could not kill process ${pid}:`, err);
    }
    fs.unlinkSync(pidFile);
  }

  // Optionally keep pb_test_data for debugging; remove it by default
  const testDir = path.join(process.cwd(), PB_TEST_DIR);
  if (!process.env.PW_KEEP_TEST_DATA && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('  Test data directory removed');
  }
}
