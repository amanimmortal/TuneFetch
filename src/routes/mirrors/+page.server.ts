import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueRefreshStaleAll } from '$lib/server/mirror';
import { runOrphanScan } from '$lib/server/scheduler';

// ── Row types ─────────────────────────────────────────────────────────────────

interface MirrorFileRow {
  id: number;
  list_item_id: number;
  source_path: string;
  mirror_path: string;
  status: 'pending' | 'active' | 'stale';
  created_at: string;
  updated_at: string;
  // Joined fields
  item_title: string;
  artist_name: string;
  list_name: string;
}

interface OrphanRow {
  id: number;
  file_path: string;
  root_folder: string;
  found_at: string;
}

// ── Load ──────────────────────────────────────────────────────────────────────

export const load: PageServerLoad = async () => {
  const db = getDb();

  // Summary counts by status
  const statRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM mirror_files GROUP BY status`
    )
    .all() as Array<{ status: string; count: number }>;

  const statMap = Object.fromEntries(statRows.map((r) => [r.status, r.count]));
  const totalFiles = statRows.reduce((s, r) => s + r.count, 0);

  // Active mirror files (newest first, capped to avoid UI overload)
  const activeFiles = db
    .prepare(
      `SELECT mf.id, mf.list_item_id, mf.source_path, mf.mirror_path,
              mf.status, mf.created_at, mf.updated_at,
              li.title AS item_title, li.artist_name,
              l.name  AS list_name
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
         JOIN lists l       ON l.id  = li.list_id
        WHERE mf.status = 'active'
        ORDER BY mf.updated_at DESC
        LIMIT 200`
    )
    .all() as MirrorFileRow[];

  // Stale files — source was upgraded but mirror not yet refreshed
  const staleFiles = db
    .prepare(
      `SELECT mf.id, mf.list_item_id, mf.source_path, mf.mirror_path,
              mf.status, mf.created_at, mf.updated_at,
              li.title AS item_title, li.artist_name,
              l.name  AS list_name
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
         JOIN lists l       ON l.id  = li.list_id
        WHERE mf.status = 'stale'
        ORDER BY mf.updated_at DESC`
    )
    .all() as MirrorFileRow[];

  // Pending files — copy was attempted but not yet successful
  const pendingFiles = db
    .prepare(
      `SELECT mf.id, mf.list_item_id, mf.source_path, mf.mirror_path,
              mf.status, mf.created_at, mf.updated_at,
              li.title AS item_title, li.artist_name,
              l.name  AS list_name
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
         JOIN lists l       ON l.id  = li.list_id
        WHERE mf.status = 'pending'
        ORDER BY mf.updated_at DESC`
    )
    .all() as MirrorFileRow[];

  // Orphan files from the most recent scan
  const orphans = db
    .prepare(
      `SELECT id, file_path, root_folder, found_at
         FROM orphan_files
        ORDER BY found_at DESC
        LIMIT 500`
    )
    .all() as OrphanRow[];

  // Last scan time (most recent found_at, or null if no scan run yet)
  const lastScanRow = db
    .prepare(`SELECT MAX(found_at) AS last_scan FROM orphan_files`)
    .get() as { last_scan: string | null };

  return {
    totalFiles,
    activeCount:  statMap['active']  ?? 0,
    staleCount:   statMap['stale']   ?? 0,
    pendingCount: statMap['pending'] ?? 0,
    activeFiles,
    staleFiles,
    pendingFiles,
    orphans,
    lastScan: lastScanRow.last_scan
  };
};

// ── Actions ───────────────────────────────────────────────────────────────────

export const actions: Actions = {
  /**
   * Enqueue re-copy of all stale mirror files as a background job.
   * Returns immediately with the count of files queued so the UI can show
   * feedback without holding the HTTP connection open for large backlogs.
   * Progress is visible on the next page reload (status updates per-file).
   */
  refreshStale: async () => {
    const queued = enqueueRefreshStaleAll();
    return { queued };
  },

  /**
   * Run the orphan detection scan immediately (on-demand).
   */
  scanNow: async () => {
    try {
      await runOrphanScan();
      return { scanned: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(500, { scanError: msg });
    }
  }
};
