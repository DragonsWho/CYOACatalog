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
      console.warn(`  Could not kill process ${pid}:`, err);
    }
    fs.unlinkSync(pidFile);
  }

  // PB keeps writing its WAL briefly after SIGTERM; on FUSE/NTFS rm raced into ENOTEMPTY and failed
  // the run after all tests passed (and poisoned the next run). Retry, then warn instead of
  // throwing — next setup wipes the dir anyway.
  const testDir = path.join(process.cwd(), PB_TEST_DIR);
  if (!process.env.PW_KEEP_TEST_DATA && fs.existsSync(testDir)) {
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
        removed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    console.log(removed
      ? '  Test data directory removed'
      : `  Could not remove ${PB_TEST_DIR} (locked by the filesystem); next run will wipe it`);
  }
}
