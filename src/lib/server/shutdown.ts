/**
 * Graceful shutdown handler.
 *
 * On SIGTERM or SIGINT:
 *   1. Wait up to 15 seconds for any in-progress mirror backfill jobs to finish.
 *   2. Close the SQLite connection cleanly.
 *   3. Exit with code 0.
 *
 * registerShutdownHandlers() is idempotent — safe to call from hooks.server.ts
 * on every request (guarded by a module-level flag).
 */

import { closeDb } from './db';
import { flushPendingCopies } from './mirror';

let _registered = false;

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} received — flushing pending mirror jobs...`);
  try {
    await flushPendingCopies(15_000);
  } catch (err) {
    console.error('[shutdown] Error while flushing jobs:', err);
  }
  console.log('[shutdown] Closing database...');
  closeDb();
  console.log('[shutdown] Clean exit.');
  process.exit(0);
}

export function registerShutdownHandlers(): void {
  if (_registered) return;
  _registered = true;
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
}
