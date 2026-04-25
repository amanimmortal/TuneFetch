/**
 * Mirror file copy service.
 *
 * Handles all file system operations for the mirroring workflow:
 * - Atomic file copies (temp-file + rename)
 * - Path construction (secondary root folder mirror of owner root folder)
 * - Per-artist backfill jobs (fire-and-forget, runs after a cross-library add)
 * - Re-mirroring on Lidarr upgrade events
 *
 * All DB writes use getDb() and are synchronous (better-sqlite3).
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, relative, join } from 'node:path';
import { getDb } from './db';
import { getTrackFiles, getTracks, type LidarrTrackFile } from './lidarr';

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Construct the destination path for a mirrored file.
 *
 * Replaces the owning root folder prefix with the secondary list's root folder,
 * preserving the relative sub-path that Lidarr uses under that root.
 *
 * @example
 *   buildMirrorPath(
 *     '/mnt/music/parents/Radiohead/OK Computer/05 - Let Down.mp3',
 *     '/mnt/music/parents',
 *     '/mnt/music/kids'
 *   )
 *   // → '/mnt/music/kids/Radiohead/OK Computer/05 - Let Down.mp3'
 */
export function buildMirrorPath(
  sourcePath: string,
  ownerRoot: string,
  targetRoot: string
): string {
  const rel = relative(ownerRoot, sourcePath);
  return join(targetRoot, rel);
}

// ── Permission pre-flight ─────────────────────────────────────────────────────

/**
 * Verify that the process has write access to a directory.
 *
 * Throws a descriptive Error (rather than a raw EACCES) if the check fails,
 * so users see actionable guidance in the logs before any copy is attempted.
 */
async function checkWritable(dir: string): Promise<void> {
  try {
    await fs.access(dir, fsConstants.W_OK);
  } catch {
    throw new Error(
      `Mirror target directory "${dir}" is not writable by the current process user. ` +
      `On Unraid, set PUID=99 and PGID=100 to match default share permissions, ` +
      `and UMASK=000 so created files are readable by all shares.`
    );
  }
}

// ── Low-level copy ────────────────────────────────────────────────────────────

/**
 * Atomically copy a file from sourcePath to destPath.
 *
 * Creates all intermediate directories. Uses a `.tunefetch.tmp` temp file
 * alongside the destination, then renames it into place so a partial write
 * never leaves a corrupt destination file.
 *
 * Throws on any filesystem error.
 */
export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  await fs.mkdir(dirname(destPath), { recursive: true });
  const tmp = destPath + '.tunefetch.tmp';
  try {
    await fs.copyFile(sourcePath, tmp);
    await fs.rename(tmp, destPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {}); // best-effort cleanup
    throw err;
  }
}

// ── Per-file mirror operations ────────────────────────────────────────────────

/**
 * Copy one track file into a secondary list's root folder and record it
 * in mirror_files.
 *
 * Creates a new mirror_files row (status='active') on first call,
 * or updates the existing row if the source_path is already tracked.
 */
export async function mirrorTrackFile(
  sourcePath: string,
  listItemId: number,
  ownerRoot: string,
  targetRoot: string
): Promise<void> {
  const mirrorPath = buildMirrorPath(sourcePath, ownerRoot, targetRoot);
  await copyFile(sourcePath, mirrorPath);

  const db = getDb();
  const existing = db
    .prepare(
      'SELECT id FROM mirror_files WHERE list_item_id = ? AND source_path = ?'
    )
    .get(listItemId, sourcePath) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE mirror_files
          SET mirror_path = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(mirrorPath, existing.id);
  } else {
    db.prepare(
      `INSERT INTO mirror_files (list_item_id, source_path, mirror_path, status)
         VALUES (?, ?, ?, 'active')`
    ).run(listItemId, sourcePath, mirrorPath);
  }
}

/**
 * Re-mirror a file that Lidarr has upgraded (replaced with a higher-quality version).
 *
 * Finds all mirror_files rows whose source_path matches the old file path,
 * copies from the new source path to the same mirror destination, and
 * updates source_path + status. If the copy fails the row is marked 'stale'.
 *
 * Called by the webhook handler on Upgrade events.
 */
export async function remirrorUpgrade(
  oldSourcePath: string,
  newSourcePath: string
): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, mirror_path FROM mirror_files WHERE source_path = ?')
    .all(oldSourcePath) as Array<{ id: number; mirror_path: string }>;

  for (const row of rows) {
    try {
      await copyFile(newSourcePath, row.mirror_path);
      db.prepare(
        `UPDATE mirror_files
            SET source_path = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newSourcePath, row.id);
    } catch (err) {
      console.error(`[mirror] re-copy failed for mirror_file ${row.id}:`, err);
      db.prepare(
        `UPDATE mirror_files
            SET source_path = ?, status = 'stale', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newSourcePath, row.id);
    }
  }
}

// ── Backfill job tracking (for graceful shutdown) ─────────────────────────────

/** Set of currently running backfill Promises — used by flushPendingCopies(). */
const _activeJobs = new Set<Promise<void>>();

/**
 * Wait for all in-progress backfill jobs to settle.
 *
 * Called during graceful shutdown to avoid interrupting mid-copy.
 * If jobs don't finish within `timeoutMs` the wait is abandoned — the caller
 * should then close the DB and exit.
 */
export async function flushPendingCopies(timeoutMs = 15_000): Promise<void> {
  if (_activeJobs.size === 0) return;
  console.log(`[mirror] Waiting for ${_activeJobs.size} active backfill job(s)...`);
  await Promise.race([
    Promise.allSettled([..._activeJobs]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

// ── Backfill job ──────────────────────────────────────────────────────────────

/**
 * Backfill all already-downloaded files for an artist into a secondary list's
 * root folder.
 *
 * This is called fire-and-forget when a cross-library add is detected:
 *   startBackfill(...).catch(console.error);
 *
 * Active jobs are tracked in `_activeJobs` so graceful shutdown can wait for them.
 *
 * Lifecycle:
 *   → list_item.sync_status = 'mirror_active'  (while copying)
 *   → 'mirror_pending'  (if no files downloaded yet — webhook will handle later)
 *   → 'synced'          (all files copied successfully)
 *   → 'mirror_broken'   (one or more copies failed)
 */
export function startBackfill(
  lidarrArtistId: number,
  listItemId: number,
  ownerRoot: string,
  targetRoot: string
): Promise<void> {
  const job = _runBackfill(lidarrArtistId, listItemId, ownerRoot, targetRoot);
  _activeJobs.add(job);
  job.finally(() => _activeJobs.delete(job)).catch(() => {});
  return job;
}

async function _runBackfill(
  lidarrArtistId: number,
  listItemId: number,
  ownerRoot: string,
  targetRoot: string
): Promise<void> {
  const db = getDb();

  console.log(`[mirror] backfill start — listItem=${listItemId} lidarrArtist=${lidarrArtistId} target="${targetRoot}"`);

  db.prepare(
    `UPDATE list_items SET sync_status = 'mirror_active', sync_error = NULL WHERE id = ?`
  ).run(listItemId);

  try {
    // Fail fast with a human-readable message if the mount point isn't writable.
    await checkWritable(targetRoot);

    // Determine the scope of this list_item so we only mirror the files it
    // actually represents — not every file by the artist.
    const listItem = db
      .prepare('SELECT type, lidarr_album_id, lidarr_track_id FROM list_items WHERE id = ?')
      .get(listItemId) as
        | { type: 'artist' | 'album' | 'track'; lidarr_album_id: number | null; lidarr_track_id: number | null }
        | undefined;

    if (!listItem) {
      throw new Error(`list_item ${listItemId} not found — cannot determine mirror scope`);
    }

    const allTrackFiles = await getTrackFiles(lidarrArtistId);

    let trackFiles: LidarrTrackFile[];

    if (listItem.type === 'artist') {
      // Mirror everything downloaded for this artist.
      trackFiles = allTrackFiles;
    } else if (listItem.type === 'album') {
      // Mirror only files belonging to the specific album.
      trackFiles = allTrackFiles.filter((f) => f.albumId === listItem.lidarr_album_id);
    } else {
      // Mirror only the single track file.
      // LidarrTrack carries a `trackFileId` field that links to the track file's
      // numeric id — it is present in the Lidarr v1 API but not currently typed
      // in our LidarrTrack interface, so we read it via the index signature.
      if (listItem.lidarr_track_id !== null) {
        const allTracks = await getTracks(lidarrArtistId);
        const track = allTracks.find((t) => t.id === listItem.lidarr_track_id);
        const trackFileId = track
          ? (track as unknown as { trackFileId?: number }).trackFileId
          : undefined;
        trackFiles =
          trackFileId !== undefined && trackFileId > 0
            ? allTrackFiles.filter((f) => f.id === trackFileId)
            : [];
      } else {
        trackFiles = [];
      }
    }

    console.log(
      `[mirror] backfill listItem=${listItemId} (${listItem.type}): ` +
      `${trackFiles.length} of ${allTrackFiles.length} artist file(s) in scope`
    );

    if (trackFiles.length === 0) {
      // No files on disk yet — stay mirror_pending; webhook will trigger copies later.
      db.prepare(
        `UPDATE list_items SET sync_status = 'mirror_pending' WHERE id = ?`
      ).run(listItemId);
      console.log(`[mirror] backfill listItem=${listItemId}: no files on disk yet → mirror_pending`);
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const file of trackFiles) {
      try {
        await mirrorTrackFile(file.path, listItemId, ownerRoot, targetRoot);
        successCount++;
      } catch (err) {
        console.error(`[mirror] backfill listItem=${listItemId}: failed to copy ${file.path}:`, err);
        errorCount++;
        // Record a pending mirror_files row so the failure is visible
        const mirrorPath = buildMirrorPath(file.path, ownerRoot, targetRoot);
        const existing = db
          .prepare(
            'SELECT id FROM mirror_files WHERE list_item_id = ? AND source_path = ?'
          )
          .get(listItemId, file.path) as { id: number } | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO mirror_files (list_item_id, source_path, mirror_path, status)
               VALUES (?, ?, ?, 'pending')`
          ).run(listItemId, file.path, mirrorPath);
        }
      }
    }

    if (successCount === 0) {
      const msg = `All ${errorCount} file copies failed during backfill`;
      db.prepare(
        `UPDATE list_items SET sync_status = 'mirror_broken', sync_error = ? WHERE id = ?`
      ).run(msg, listItemId);
      console.error(`[mirror] backfill listItem=${listItemId}: ${msg}`);
    } else if (errorCount > 0) {
      const msg = `Backfill partially failed: ${errorCount} of ${trackFiles.length} files could not be copied`;
      db.prepare(
        `UPDATE list_items SET sync_status = 'mirror_broken', sync_error = ? WHERE id = ?`
      ).run(msg, listItemId);
      console.error(`[mirror] backfill listItem=${listItemId}: ${msg}`);
    } else {
      db.prepare(
        `UPDATE list_items SET sync_status = 'synced', sync_error = NULL WHERE id = ?`
      ).run(listItemId);
      console.log(`[mirror] backfill listItem=${listItemId}: complete — ${successCount} file(s) copied → synced`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mirror] backfill listItem=${listItemId}: fatal error —`, err);
    db.prepare(
      `UPDATE list_items SET sync_status = 'mirror_broken', sync_error = ? WHERE id = ?`
    ).run(msg, listItemId);
  }
}

// ── Stale-file refresh queue ──────────────────────────────────────────────────

/**
 * Re-copy all stale mirror files in the background.
 *
 * Queues each stale row through the existing _activeJobs set so graceful
 * shutdown waits for in-progress copies. Returns the number of rows queued
 * so the caller can show progress in the UI immediately.
 *
 * Each copy updates the row status individually — if some succeed and others
 * fail, the dashboard accurately reflects the mixed state.
 */
export function enqueueRefreshStaleAll(): number {
  const db = getDb();
  const staleRows = db
    .prepare(`SELECT id, source_path, mirror_path FROM mirror_files WHERE status = 'stale'`)
    .all() as Array<{ id: number; source_path: string; mirror_path: string }>;

  for (const row of staleRows) {
    const job = _refreshSingleStale(row.id, row.source_path, row.mirror_path);
    _activeJobs.add(job);
    job.finally(() => _activeJobs.delete(job)).catch(() => {});
  }

  return staleRows.length;
}

async function _refreshSingleStale(
  mirrorFileId: number,
  sourcePath: string,
  mirrorPath: string
): Promise<void> {
  try {
    await copyFile(sourcePath, mirrorPath);
    getDb()
      .prepare(`UPDATE mirror_files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(mirrorFileId);
  } catch (err) {
    console.error(`[mirror] refreshStale failed for mirror_file ${mirrorFileId} (${sourcePath}):`, err);
    // Leave status as 'stale' — the user can retry or investigate via the mirrors page.
  }
}

// ── Stale-file refresh queue ──────────────────────────────────────────────────

/**
 * Re-copy all stale mirror files in the background.
 *
 * Queues each stale row through the existing _activeJobs set so graceful
 * shutdown waits for in-progress copies. Returns the number of rows queued
 * so the caller can show progress in the UI immediately.
 *
 * Each copy updates the row status individually — if some succeed and others
 * fail, the dashboard accurately reflects the mixed state.
 */
export function enqueueRefreshStaleAll(): number {
  const db = getDb();
  const staleRows = db
    .prepare(`SELECT id, source_path, mirror_path FROM mirror_files WHERE status = 'stale'`)
    .all() as Array<{ id: number; source_path: string; mirror_path: string }>;

  for (const row of staleRows) {
    const job = _refreshSingleStale(row.id, row.source_path, row.mirror_path);
    _activeJobs.add(job);
    job.finally(() => _activeJobs.delete(job)).catch(() => {});
  }

  return staleRows.length;
}

async function _refreshSingleStale(
  mirrorFileId: number,
  sourcePath: string,
  mirrorPath: string
): Promise<void> {
  try {
    await copyFile(sourcePath, mirrorPath);
    getDb()
      .prepare(`UPDATE mirror_files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(mirrorFileId);
  } catch (err) {
    console.error(`[mirror] refreshStale failed for mirror_file ${mirrorFileId} (${sourcePath}):`, err);
    // Leave status as 'stale' — the user can retry or investigate via the mirrors page.
  }
}
