import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueRefreshStaleAll, pruneOutOfScopeMirrors } from '$lib/server/mirror';
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

const ORPHAN_DISPLAY_LIMIT = 500;

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

  // Total orphan count (separate from the display-capped list)
  const orphanTotalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM orphan_files`)
    .get() as { count: number };

  // Orphan files from the most recent scan (capped for display)
  const orphans = db
    .prepare(
      `SELECT id, file_path, root_folder, found_at
         FROM orphan_files
        ORDER BY file_path ASC
        LIMIT ${ORPHAN_DISPLAY_LIMIT}`
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
    orphanTotal: orphanTotalRow.count,
    orphanCapped: orphanTotalRow.count > ORPHAN_DISPLAY_LIMIT,
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
   * Run the out-of-scope pruning immediately (on-demand).
   * Finds mirror rows whose files no longer belong in the target list (e.g., legacy full-artist syncs)
   * and deletes them from disk and the database.
   */
  prune: async () => {
    try {
      const pruned = await pruneOutOfScopeMirrors();
      return { pruned };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(500, { pruneError: msg });
    }
  },

  /**
   * Run the orphan detection scan + mirror integrity check immediately (on-demand).
   * Returns orphan and newly-stale counts so the UI can show actionable feedback.
   */
  scanNow: async () => {
    try {
      await runOrphanScan();
      // orphanTotal is reloaded on the next page render via data; return scanned=true
      // so the feedback banner shows. staleCount is also reloaded from fresh data.
      return { scanned: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(500, { scanError: msg });
    }
  },

  /**
   * Add a single orphan to the permanent ignore list and remove it from
   * the current scan results. The file will not reappear in future scans.
   */
  dismissOrphan: async ({ request }) => {
    const data = await request.formData();
    const filePath = data.get('file_path');
    if (typeof filePath !== 'string' || !filePath) {
      return fail(400, { dismissError: 'Missing file_path' });
    }
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO orphan_ignore_list (file_path) VALUES (?)`
    ).run(filePath);
    db.prepare(`DELETE FROM orphan_files WHERE file_path = ?`).run(filePath);
    return { dismissed: 1 };
  },

  /**
   * Add ALL current orphans to the permanent ignore list and clear the table.
   * Use this to bulk-dismiss pre-existing files that TuneFetch did not create.
   */
  dismissAllOrphans: async () => {
    const db = getDb();
    const count = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO orphan_ignore_list (file_path)
         SELECT file_path FROM orphan_files`
      ).run();
      const { changes } = db.prepare(`DELETE FROM orphan_files`).run();
      return changes;
    })();
    return { dismissed: count };
  }
};
