/**
 * In-process scheduler for the nightly orphan detection scan.
 *
 * Design:
 * - Single setTimeout chain — each run schedules the next one.
 * - Schedule is read from settings at run time so a settings change
 *   takes effect at the next scheduled run without a restart.
 * - startScheduler() is idempotent — safe to call from hooks.server.ts
 *   on every request (guarded by a module-level flag).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db';
import { getSetting, SETTING_KEYS } from './settings';
import { cleanupExpiredSessions } from './auth';
import { systemStatus } from './lidarr';

// ── Orphan detection ──────────────────────────────────────────────────────────

/**
 * Recursively walk a directory, calling visitor(filePath) for each file.
 * Silently skips entries that can't be read (e.g. permission errors).
 */
async function walkDir(
  dir: string,
  visitor: (filePath: string) => Promise<void>
): Promise<void> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return; // directory not accessible — skip
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, visitor);
    } else if (entry.isFile()) {
      // Skip temp files left by a failed/interrupted copy
      if (!entry.name.endsWith('.tunefetch.tmp')) {
        await visitor(fullPath);
      }
    }
  }
}

/**
 * Run the orphan detection scan.
 *
 * Scans all root folders that TuneFetch has used as mirror destinations
 * (i.e. folders that appear in mirror_files rows via their list_item → list
 * join). Any file found under those folders that has no matching
 * mirror_files.mirror_path record is recorded in orphan_files.
 *
 * Orphans are flagged for user review only — they are never auto-deleted.
 * The table is fully replaced on each scan so stale results don't accumulate.
 */
export async function runOrphanScan(): Promise<void> {
  const db = getDb();

  console.log('[scheduler] Starting orphan scan...');

  // Find root folders that TuneFetch actively uses as mirror destinations.
  // Join through list_items → lists to get the root_folder_path.
  const secondaryRoots = db
    .prepare(
      `SELECT DISTINCT l.root_folder_path
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
         JOIN lists l       ON l.id  = li.list_id`
    )
    .all() as Array<{ root_folder_path: string }>;

  if (secondaryRoots.length === 0) {
    console.log('[scheduler] Orphan scan: no mirror destinations found — skipping.');
    return;
  }

  // Build a Set of all known mirror paths for fast lookup.
  const knownPaths = new Set(
    (
      db.prepare('SELECT mirror_path FROM mirror_files').all() as Array<{
        mirror_path: string;
      }>
    ).map((r) => r.mirror_path)
  );

  // Replace previous scan results.
  db.prepare('DELETE FROM orphan_files').run();

  let orphanCount = 0;

  for (const { root_folder_path } of secondaryRoots) {
    await walkDir(root_folder_path, async (filePath) => {
      if (!knownPaths.has(filePath)) {
        db.prepare(
          `INSERT OR REPLACE INTO orphan_files (file_path, root_folder) VALUES (?, ?)`
        ).run(filePath, root_folder_path);
        orphanCount++;
      }
    });
  }

  console.log(`[scheduler] Orphan scan complete. Found ${orphanCount} orphan(s).`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const DEFAULT_SCAN_TIME = '03:00';

/**
 * Calculate milliseconds until the next occurrence of HH:MM (24-hour, local time).
 * Always returns a positive value — if the time has already passed today,
 * returns the time until tomorrow.
 */
function msUntilNextRun(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0] ?? '3', 10);
  const minutes = parseInt(parts[1] ?? '0', 10);

  if (isNaN(hours) || isNaN(minutes)) {
    console.warn(`[scheduler] Invalid orphan_scan_time "${timeStr}", defaulting to 03:00`);
    return msUntilNextRun(DEFAULT_SCAN_TIME);
  }

  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

// ── Session cleanup ───────────────────────────────────────────────────────────

/**
 * Start the hourly session-cleanup interval.
 * Deletes rows from the sessions table where expires_at < now.
 */
function startSessionCleanup(): void {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(() => {
    try {
      cleanupExpiredSessions();
    } catch (err) {
      console.error('[scheduler] Session cleanup failed:', err);
    }
  }, INTERVAL_MS).unref(); // unref so this timer doesn't prevent process exit
}

// ── Lidarr connectivity + webhook reminder ────────────────────────────────────

/**
 * Check Lidarr reachability on startup and warn if it's unreachable.
 *
 * Also logs a reminder about the webhook configuration, since a missing
 * webhook registration means mirror_pending items will never resolve
 * (Risk §8 item 2).
 */
async function checkLidarrOnStartup(): Promise<void> {
  try {
    const status = await systemStatus();
    console.log(`[startup] Lidarr reachable — version ${status.version}`);
    console.log(
      '[startup] Reminder: ensure the Lidarr webhook is configured under ' +
        'Settings → Connect → Webhook with events: On Download, On Upgrade.'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[startup] WARNING: Lidarr is not reachable (${msg}). ` +
        'Mirror workflows will not function until Lidarr is configured in Settings.'
    );
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _started = false;

/** Schedule the next orphan scan run (recursive tail-schedule). */
function scheduleNextRun(): void {
  const timeStr = getSetting(SETTING_KEYS.ORPHAN_SCAN_TIME) ?? DEFAULT_SCAN_TIME;
  const ms = msUntilNextRun(timeStr);
  const nextTime = new Date(Date.now() + ms).toLocaleTimeString();
  console.log(`[scheduler] Next orphan scan scheduled for ${nextTime} (in ${Math.round(ms / 60000)} min)`);

  setTimeout(() => {
    runOrphanScan()
      .catch((err) => console.error('[scheduler] Orphan scan failed:', err))
      .finally(() => scheduleNextRun());
  }, ms);
}

/**
 * Start the nightly scheduler. Idempotent — only starts once per process.
 * Call from hooks.server.ts on first request.
 */
export function startScheduler(): void {
  if (_started) return;
  _started = true;
  scheduleNextRun();
  startSessionCleanup();
  // Non-blocking — don't await; log warnings asynchronously.
  checkLidarrOnStartup().catch((err) =>
    console.error('[startup] Lidarr check failed unexpectedly:', err)
  );
}
