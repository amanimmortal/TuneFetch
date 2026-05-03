/**
 * Mirror file copy service.
 *
 * Handles all file system operations for the mirroring workflow:
 * - Atomic file copies (temp-file + rename)
 * - Path construction (secondary root folder mirror of owner root folder)
 * - Per-artist backfill jobs (fire-and-forget, runs after a cross-library add)
 * - Re-mirroring on Lidarr upgrade events
 * - Self-healing: when a cached source_path is invalid, re-resolve it from
 *   Lidarr using the stable trackFileId / trackId handles, then retry.
 *
 * All DB writes use getDb() and are synchronous (better-sqlite3).
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, relative, join, basename } from 'node:path';
import { getDb } from './db';
import {
  getTrackFiles,
  getTracks,
  LidarrError,
  type LidarrTrack,
  type LidarrTrackFile
} from './lidarr';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Stable Lidarr handles attached to a mirrored file.
 *
 * trackFileId is the primary key — Lidarr's id for the file row in its
 * trackfile table, stable across renames/moves. trackId is an extra hedge:
 * after an upgrade Lidarr replaces the trackFile but the track itself keeps
 * its id, so we can re-derive the new trackFileId from the track.
 */
export interface LidarrHandles {
  trackFileId: number;
  trackId?: number;
}

interface MirrorRow {
  id: number;
  list_item_id: number;
  source_path: string;
  mirror_path: string;
  status: 'pending' | 'active' | 'stale';
  lidarr_track_file_id: number | null;
  lidarr_track_id: number | null;
}

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

// ── Self-healing source resolution ────────────────────────────────────────────

/**
 * Cache of `getTrackFiles(artistId)` results, keyed by artistId.
 *
 * When the verifier or a self-heal is processing many rows for the same
 * artist, this avoids hammering Lidarr with one request per file. The cache
 * is a parameter passed into the resolver so callers control its lifetime —
 * a single backfill or verify pass shares one cache, but unrelated calls
 * always start fresh and see current Lidarr state.
 */
export type TrackFileCache = Map<number, Promise<LidarrTrackFile[]>>;

export function newTrackFileCache(): TrackFileCache {
  return new Map();
}

function getTrackFilesCached(
  artistId: number,
  cache: TrackFileCache
): Promise<LidarrTrackFile[]> {
  let p = cache.get(artistId);
  if (!p) {
    p = getTrackFiles(artistId);
    cache.set(artistId, p);
  }
  return p;
}

/**
 * Look up the current source path for a mirror_files row by asking Lidarr.
 *
 * Resolution strategy, in order:
 *   1. lidarr_track_file_id present → find the file in Lidarr's current
 *      trackfile list for the artist.
 *   2. lidarr_track_id present → find the track, follow its trackFileId,
 *      then look up the file. This survives upgrades (track id is stable,
 *      trackFileId may have been replaced).
 *   3. Legacy fallback (no handles) → match by basename + relative-path
 *      shape against all of the artist's track files. If exactly one match,
 *      adopt it and persist the trackFileId so we don't have to guess again.
 *
 * Returns the fresh source path if found, or null if Lidarr no longer has
 * any file for this row (genuinely broken — caller should mark the list_item
 * mirror_broken and surface to the user).
 *
 * Side effects: when we discover a new path or a new trackFileId, the row
 * is updated immediately so subsequent calls converge on stable handles.
 */
async function resolveCurrentSourcePath(
  row: MirrorRow,
  cache: TrackFileCache
): Promise<string | null> {
  const db = getDb();

  // We need the artist id to query Lidarr. It lives on the parent list_item.
  const li = db
    .prepare('SELECT lidarr_artist_id FROM list_items WHERE id = ?')
    .get(row.list_item_id) as { lidarr_artist_id: number | null } | undefined;

  if (!li || li.lidarr_artist_id == null) {
    return null;
  }
  const artistId = li.lidarr_artist_id;

  let trackFiles: LidarrTrackFile[];
  try {
    trackFiles = await getTrackFilesCached(artistId, cache);
  } catch (err) {
    // Network error or Lidarr down — caller will leave row stale and retry later.
    if (err instanceof LidarrError) {
      throw err;
    }
    throw err;
  }

  // Strategy 1: by trackFileId.
  if (row.lidarr_track_file_id != null) {
    const file = trackFiles.find((f) => f.id === row.lidarr_track_file_id);
    if (file) return file.path;
    // trackFileId not found — file was deleted (or replaced via upgrade).
    // Fall through to strategy 2 if we have trackId.
  }

  // Strategy 2: by trackId → trackFileId → path.
  if (row.lidarr_track_id != null) {
    let tracks: LidarrTrack[];
    try {
      tracks = await getTracks(artistId);
    } catch {
      tracks = [];
    }
    const track = tracks.find((t) => t.id === row.lidarr_track_id);
    const newTrackFileId = track
      ? (track as unknown as { trackFileId?: number }).trackFileId
      : undefined;
    if (newTrackFileId && newTrackFileId > 0) {
      const file = trackFiles.find((f) => f.id === newTrackFileId);
      if (file) {
        // Persist the refreshed trackFileId so future lookups skip step 2.
        db.prepare(
          `UPDATE mirror_files SET lidarr_track_file_id = ? WHERE id = ?`
        ).run(newTrackFileId, row.id);
        return file.path;
      }
    }
  }

  // Strategy 3: legacy path matching. Heuristic but bounded — accept only
  // if exactly one file matches the cached source_path's basename.
  const wantBase = basename(row.source_path);
  const candidates = trackFiles.filter((f) => basename(f.path) === wantBase);
  if (candidates.length === 1) {
    const file = candidates[0]!;
    db.prepare(
      `UPDATE mirror_files SET lidarr_track_file_id = ? WHERE id = ?`
    ).run(file.id, row.id);
    return file.path;
  }
  // Multiple matches with the same basename (e.g. duplicate disc-N folders) —
  // ambiguous; prefer not to guess. Try the row's exact source_path next.
  const exact = trackFiles.find((f) => f.path === row.source_path);
  if (exact) {
    db.prepare(
      `UPDATE mirror_files SET lidarr_track_file_id = ? WHERE id = ?`
    ).run(exact.id, row.id);
    return exact.path;
  }

  return null;
}

// ── Copy with self-healing ────────────────────────────────────────────────────

interface HealResult {
  ok: boolean;
  /** Final source_path after any healing (may differ from the input). */
  sourcePath: string;
  /** Lidarr says this file is gone — caller should mark the item broken. */
  unresolvable: boolean;
  /** Last error encountered, if !ok. */
  error?: Error;
}

/**
 * Copy a file, healing the source path on ENOENT.
 *
 * On a missing-source error this re-queries Lidarr (via resolveCurrentSourcePath),
 * and if a fresh path is found, updates source_path on the row and retries
 * the copy exactly once. Other errors (EACCES, ENOSPC, etc.) are not retried
 * — those need user intervention, not a path refresh.
 *
 * This is the central point that turns the "ghost path" log spam into a
 * one-shot recovery: by the time control returns, either the file is on
 * disk, or the row carries an updated last_error and (if applicable) the
 * list_item is marked mirror_broken.
 */
async function copyWithHealing(
  row: MirrorRow,
  destPath: string,
  cache: TrackFileCache
): Promise<HealResult> {
  const db = getDb();
  let sourcePath = row.source_path;

  try {
    await copyFile(sourcePath, destPath);
    return { ok: true, sourcePath, unresolvable: false };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') {
      // Permission, disk-full, etc. — don't try to "heal" path.
      return {
        ok: false,
        sourcePath,
        unresolvable: false,
        error: err as Error
      };
    }
    // ENOENT can come from either source missing or a missing parent dir
    // on the destination. copyFile() mkdirs the dest parent first, so any
    // ENOENT here is the source. Proceed with re-resolution.
  }

  // Source not on disk — ask Lidarr where it is now.
  let fresh: string | null;
  try {
    fresh = await resolveCurrentSourcePath(row, cache);
  } catch (err) {
    // Lidarr unreachable — leave row alone, surface the underlying error.
    return {
      ok: false,
      sourcePath,
      unresolvable: false,
      error: err as Error
    };
  }

  if (fresh === null) {
    return {
      ok: false,
      sourcePath,
      unresolvable: true,
      error: new Error(
        `Source file no longer exists in Lidarr (cached path: ${sourcePath})`
      )
    };
  }

  if (fresh !== sourcePath) {
    db.prepare(
      `UPDATE mirror_files
          SET source_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(fresh, row.id);
    sourcePath = fresh;
    console.log(
      `[mirror] healed source_path for mirror_file ${row.id}: ${row.source_path} → ${fresh}`
    );
  }

  // Recompute mirror_path against the new source under the same target root,
  // so a Lidarr rename of the artist folder propagates through to the mirror.
  // We derive the target root from the existing mirror_path: it's the prefix
  // shared with the OLD source's relative shape under its owner root. Since
  // we don't know the owner root here, we instead use the simpler rule: keep
  // the mirror filename and recompute its parent dir from the new source.
  const newDest = _recomputeMirrorPath(row.mirror_path, row.source_path, fresh);
  if (newDest !== row.mirror_path) {
    db.prepare(
      `UPDATE mirror_files SET mirror_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(newDest, row.id);
  }

  // One retry only — if this fails, leave it for the user/verifier.
  try {
    await copyFile(sourcePath, newDest);
    return { ok: true, sourcePath, unresolvable: false };
  } catch (err) {
    return {
      ok: false,
      sourcePath,
      unresolvable: false,
      error: err as Error
    };
  }
}

/**
 * Recompute a mirror destination when the source has moved or been renamed.
 *
 * We don't have ownerRoot here, so we infer the relative tail of the old
 * source under its directory and apply the same suffix change to the
 * mirror path. Concretely: if oldSrc and newSrc share a common prefix, the
 * mirror path's tail is updated by the same diff. When the change is just
 * a filename rename in the same directory, this swaps only the basename.
 */
function _recomputeMirrorPath(
  oldMirror: string,
  oldSource: string,
  newSource: string
): string {
  // Find the longest path-aligned common suffix of oldMirror and oldSource.
  // Whatever in oldSource matches the tail of oldMirror is the "mirror tail";
  // we replace that tail using the corresponding tail of newSource.
  const oldS = oldSource.replace(/\\/g, '/').split('/');
  const oldM = oldMirror.replace(/\\/g, '/').split('/');
  const newS = newSource.replace(/\\/g, '/').split('/');

  let matchLen = 0;
  while (
    matchLen < oldS.length &&
    matchLen < oldM.length &&
    oldS[oldS.length - 1 - matchLen] === oldM[oldM.length - 1 - matchLen]
  ) {
    matchLen++;
  }
  if (matchLen === 0) return oldMirror;

  const mirrorPrefix = oldM.slice(0, oldM.length - matchLen);
  const newTail = newS.slice(Math.max(0, newS.length - matchLen));
  // Re-join using forward slashes; node:path will normalize on use.
  return [...mirrorPrefix, ...newTail].join('/');
}

// ── Per-file mirror operations ────────────────────────────────────────────────

/**
 * Copy one track file into a secondary list's root folder and record it
 * in mirror_files.
 *
 * Creates a new mirror_files row (status='active') on first call,
 * or updates the existing row if the source_path is already tracked.
 *
 * `handles` carries the stable Lidarr identifiers (trackFileId, trackId).
 * Pass them whenever you have them — backfill and webhook callers do —
 * so future failures can self-heal without resorting to path heuristics.
 */
export async function mirrorTrackFile(
  sourcePath: string,
  listItemId: number,
  ownerRoot: string,
  targetRoot: string,
  handles?: LidarrHandles
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
          SET mirror_path = ?,
              status = 'active',
              lidarr_track_file_id = COALESCE(?, lidarr_track_file_id),
              lidarr_track_id = COALESCE(?, lidarr_track_id),
              last_verified_at = CURRENT_TIMESTAMP,
              last_error = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      mirrorPath,
      handles?.trackFileId ?? null,
      handles?.trackId ?? null,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO mirror_files
         (list_item_id, source_path, mirror_path, status,
          lidarr_track_file_id, lidarr_track_id, last_verified_at)
         VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      listItemId,
      sourcePath,
      mirrorPath,
      handles?.trackFileId ?? null,
      handles?.trackId ?? null
    );
  }
}

/**
 * Re-mirror a file that Lidarr has upgraded (replaced with a higher-quality version).
 *
 * Finds matching mirror_files rows by trackFileId first (stable), falling
 * back to source_path for legacy rows. For each, copies from the new source
 * path to the same mirror destination and updates source_path + status.
 * If a copy fails the row is marked 'stale' with the error captured.
 *
 * Called by the webhook handler on Upgrade events.
 */
export async function remirrorUpgrade(
  oldSourcePath: string,
  newSourcePath: string,
  oldTrackFileId?: number,
  newTrackFileId?: number
): Promise<void> {
  const db = getDb();

  // Prefer matching by trackFileId — survives even when source_path drifted.
  const rows =
    oldTrackFileId !== undefined
      ? (db
          .prepare(
            'SELECT id, mirror_path FROM mirror_files WHERE lidarr_track_file_id = ?'
          )
          .all(oldTrackFileId) as Array<{ id: number; mirror_path: string }>)
      : (db
          .prepare('SELECT id, mirror_path FROM mirror_files WHERE source_path = ?')
          .all(oldSourcePath) as Array<{ id: number; mirror_path: string }>);

  for (const row of rows) {
    try {
      await copyFile(newSourcePath, row.mirror_path);
      db.prepare(
        `UPDATE mirror_files
            SET source_path = ?,
                status = 'active',
                lidarr_track_file_id = COALESCE(?, lidarr_track_file_id),
                last_verified_at = CURRENT_TIMESTAMP,
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newSourcePath, newTrackFileId ?? null, row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mirror] re-copy failed for mirror_file ${row.id}:`, err);
      db.prepare(
        `UPDATE mirror_files
            SET source_path = ?,
                status = 'stale',
                lidarr_track_file_id = COALESCE(?, lidarr_track_file_id),
                last_error = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newSourcePath, newTrackFileId ?? null, msg, row.id);
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

    // Build a trackFileId → trackId map so each mirrorTrackFile call gets both
    // handles. This is one extra Lidarr request per backfill regardless of how
    // many files are in scope.
    const fileToTrackId = new Map<number, number>();
    try {
      const allTracks = await getTracks(lidarrArtistId);
      for (const t of allTracks) {
        const tfid = (t as unknown as { trackFileId?: number }).trackFileId;
        if (tfid && tfid > 0) {
          fileToTrackId.set(tfid, t.id);
        }
      }
    } catch (err) {
      console.warn(`[mirror] backfill listItem=${listItemId}: getTracks failed (non-fatal):`, err);
    }

    let trackFiles: LidarrTrackFile[];

    if (listItem.type === 'artist') {
      // Mirror everything downloaded for this artist.
      trackFiles = allTrackFiles;
    } else if (listItem.type === 'album') {
      // Mirror only files belonging to the specific album.
      trackFiles = allTrackFiles.filter((f) => f.albumId === listItem.lidarr_album_id);
    } else {
      // Mirror only the single track file.
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
      // No files on disk yet — stay mirror_pending; webhook will handle copies later.
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
        await mirrorTrackFile(file.path, listItemId, ownerRoot, targetRoot, {
          trackFileId: file.id,
          trackId: fileToTrackId.get(file.id)
        });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[mirror] backfill listItem=${listItemId}: failed to copy ${file.path}:`, err);
        errorCount++;
        // Record a pending mirror_files row (with handles) so the failure is visible
        // and a future verifier run can retry without losing the Lidarr identifiers.
        const mirrorPath = buildMirrorPath(file.path, ownerRoot, targetRoot);
        const existing = db
          .prepare(
            'SELECT id FROM mirror_files WHERE list_item_id = ? AND source_path = ?'
          )
          .get(listItemId, file.path) as { id: number } | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO mirror_files
               (list_item_id, source_path, mirror_path, status,
                lidarr_track_file_id, lidarr_track_id, last_error)
               VALUES (?, ?, ?, 'pending', ?, ?, ?)`
          ).run(
            listItemId,
            file.path,
            mirrorPath,
            file.id,
            fileToTrackId.get(file.id) ?? null,
            msg
          );
        } else {
          db.prepare(
            `UPDATE mirror_files
                SET status = 'pending',
                    lidarr_track_file_id = COALESCE(?, lidarr_track_file_id),
                    lidarr_track_id = COALESCE(?, lidarr_track_id),
                    last_error = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
          ).run(file.id, fileToTrackId.get(file.id) ?? null, msg, existing.id);
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

// ── Mirror integrity check ────────────────────────────────────────────────────

/**
 * Check every active mirror_files row and mark any whose mirror_path no longer
 * exists on disk as 'stale'. Returns the number of rows marked stale.
 *
 * Called during the orphan scan so a single "Scan Now" also surfaces missing
 * files that have been deleted/moved by Lidarr or another process. The user
 * can then click "Refresh Stale" to re-copy them from the source.
 */
export async function markMissingMirrorsStale(): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, mirror_path FROM mirror_files WHERE status = 'active'`)
    .all() as Array<{ id: number; mirror_path: string }>;

  let marked = 0;
  for (const row of rows) {
    try {
      await fs.access(row.mirror_path, fsConstants.F_OK);
    } catch {
      db.prepare(
        `UPDATE mirror_files SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(row.id);
      marked++;
    }
  }
  return marked;
}

// ── Stale-file refresh queue ──────────────────────────────────────────────────

/**
 * Re-copy all stale mirror files in the background.
 *
 * Each stale row goes through copyWithHealing, so a row whose source_path
 * has gone stale (file moved/renamed in Lidarr) will be re-resolved against
 * Lidarr and retried automatically — no spam loop on a ghost path.
 *
 * Returns the number of rows queued so the caller can show progress in the
 * UI immediately.
 */
export function enqueueRefreshStaleAll(): number {
  const db = getDb();
  const staleRows = db
    .prepare(
      `SELECT id, list_item_id, source_path, mirror_path, status,
              lidarr_track_file_id, lidarr_track_id
         FROM mirror_files WHERE status = 'stale'`
    )
    .all() as MirrorRow[];

  // One shared track-file cache for the whole batch — many rows for the same
  // artist hit Lidarr only once.
  const cache = newTrackFileCache();

  for (const row of staleRows) {
    const job = _refreshSingleStale(row, cache);
    _activeJobs.add(job);
    job.finally(() => _activeJobs.delete(job)).catch(() => {});
  }

  return staleRows.length;
}

async function _refreshSingleStale(row: MirrorRow, cache: TrackFileCache): Promise<void> {
  const db = getDb();
  const result = await copyWithHealing(row, row.mirror_path, cache);

  if (result.ok) {
    db.prepare(
      `UPDATE mirror_files
          SET status = 'active',
              last_verified_at = CURRENT_TIMESTAMP,
              last_error = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(row.id);
    return;
  }

  const msg = result.error ? result.error.message : 'unknown error';

  if (result.unresolvable) {
    // Lidarr no longer has the file. Surface this on the parent list_item
    // so the user can act on it; leave the mirror row stale so the UI
    // reflects "needs attention".
    db.prepare(
      `UPDATE mirror_files
          SET last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(msg, row.id);
    db.prepare(
      `UPDATE list_items SET sync_status = 'mirror_broken', sync_error = ? WHERE id = ?`
    ).run(`Lidarr no longer has source for mirror_file ${row.id}: ${msg}`, row.list_item_id);
    console.warn(
      `[mirror] refreshStale: mirror_file ${row.id} unresolvable in Lidarr — marked list_item ${row.list_item_id} broken`
    );
    return;
  }

  db.prepare(
    `UPDATE mirror_files
        SET last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(msg, row.id);
  console.error(`[mirror] refreshStale failed for mirror_file ${row.id}:`, result.error);
}

// ── Verifier ──────────────────────────────────────────────────────────────────

export interface VerifyReport {
  scanned: number;
  pathsHealed: number;
  filesRecopied: number;
  unresolvable: number;
  errors: number;
}

/**
 * Periodic full-table verification of every mirror_files row against Lidarr.
 *
 * For each row:
 *   1. Re-fetch the artist's track files from Lidarr.
 *   2. Resolve the row's current source path. If different, update DB.
 *   3. If row is 'active' but mirror file is missing on disk, or row was
 *      'stale'/'pending', try a healed copy.
 *   4. If Lidarr no longer has the file, mark the parent list_item broken.
 *
 * Runs after the orphan scan. Safe to invoke ad-hoc; uses an internal
 * track-file cache so per-artist Lidarr calls happen at most once per run.
 *
 * The user can run this as often as they like — calls are entirely against
 * a local Lidarr instance and the local filesystem.
 */
export async function verifyMirrorFiles(): Promise<VerifyReport> {
  const db = getDb();
  const cache = newTrackFileCache();
  const report: VerifyReport = {
    scanned: 0,
    pathsHealed: 0,
    filesRecopied: 0,
    unresolvable: 0,
    errors: 0
  };

  const rows = db
    .prepare(
      `SELECT id, list_item_id, source_path, mirror_path, status,
              lidarr_track_file_id, lidarr_track_id
         FROM mirror_files
        ORDER BY list_item_id`
    )
    .all() as MirrorRow[];

  for (const row of rows) {
    report.scanned++;
    try {
      // First confirm what Lidarr currently says about this file.
      const fresh = await resolveCurrentSourcePath(row, cache);
      if (fresh === null) {
        // Lidarr doesn't know about this file anymore.
        db.prepare(
          `UPDATE mirror_files
              SET last_error = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run('Source no longer present in Lidarr', row.id);
        db.prepare(
          `UPDATE list_items SET sync_status = 'mirror_broken',
                                  sync_error = COALESCE(sync_error, ?)
             WHERE id = ?`
        ).run(
          `Lidarr no longer has source for mirror_file ${row.id}`,
          row.list_item_id
        );
        report.unresolvable++;
        continue;
      }

      let currentSource = row.source_path;
      let currentMirror = row.mirror_path;
      if (fresh !== currentSource) {
        const newMirror = _recomputeMirrorPath(currentMirror, currentSource, fresh);
        db.prepare(
          `UPDATE mirror_files
              SET source_path = ?,
                  mirror_path = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(fresh, newMirror, row.id);
        currentSource = fresh;
        currentMirror = newMirror;
        report.pathsHealed++;
        // The destination on disk still sits at the old mirror_path; that
        // file is now an orphan-on-disk and the next scan will surface it
        // for cleanup. We need to copy fresh content to the new mirror_path.
      }

      // Decide whether a copy is needed.
      let mirrorOnDisk = false;
      try {
        await fs.access(currentMirror, fsConstants.F_OK);
        mirrorOnDisk = true;
      } catch {
        mirrorOnDisk = false;
      }

      const needsCopy =
        row.status !== 'active' || !mirrorOnDisk || fresh !== row.source_path;

      if (needsCopy) {
        try {
          await copyFile(currentSource, currentMirror);
          db.prepare(
            `UPDATE mirror_files
                SET status = 'active',
                    last_verified_at = CURRENT_TIMESTAMP,
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
          ).run(row.id);
          report.filesRecopied++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          db.prepare(
            `UPDATE mirror_files
                SET status = CASE WHEN status = 'active' THEN 'stale' ELSE status END,
                    last_error = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
          ).run(msg, row.id);
          report.errors++;
        }
      } else {
        // Healthy — record the verification timestamp.
        db.prepare(
          `UPDATE mirror_files
              SET last_verified_at = CURRENT_TIMESTAMP,
                  last_error = NULL
            WHERE id = ?`
        ).run(row.id);
      }
    } catch (err) {
      // Lidarr unreachable, etc. — don't punish the row, just count and move on.
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE mirror_files SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(msg, row.id);
      report.errors++;
    }
  }

  return report;
}

// ── Legacy handle backfill ────────────────────────────────────────────────────

/**
 * Populate lidarr_track_file_id / lidarr_track_id for rows that predate the
 * self-healing columns.
 *
 * Strategy: query Lidarr per artist (cached), match cached source_path to
 * a current Lidarr trackFile by exact path, then by basename if exactly one
 * candidate. Rows that can't be resolved are left as-is — the verifier and
 * on-failure healer handle them with their own legacy fallbacks.
 *
 * Idempotent: only touches rows where lidarr_track_file_id IS NULL.
 */
export async function backfillLegacyHandles(): Promise<number> {
  const db = getDb();
  const cache = newTrackFileCache();

  const rows = db
    .prepare(
      `SELECT mf.id, mf.list_item_id, mf.source_path, mf.mirror_path, mf.status,
              mf.lidarr_track_file_id, mf.lidarr_track_id,
              li.lidarr_artist_id
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
        WHERE mf.lidarr_track_file_id IS NULL
          AND li.lidarr_artist_id IS NOT NULL`
    )
    .all() as Array<MirrorRow & { lidarr_artist_id: number }>;

  let updated = 0;
  for (const row of rows) {
    try {
      const trackFiles = await getTrackFilesCached(row.lidarr_artist_id, cache);
      const exact = trackFiles.find((f) => f.path === row.source_path);
      let chosen: LidarrTrackFile | undefined = exact;
      if (!chosen) {
        const wantBase = basename(row.source_path);
        const candidates = trackFiles.filter((f) => basename(f.path) === wantBase);
        if (candidates.length === 1) chosen = candidates[0];
      }
      if (chosen) {
        db.prepare(
          `UPDATE mirror_files SET lidarr_track_file_id = ? WHERE id = ?`
        ).run(chosen.id, row.id);
        updated++;
      }
    } catch (err) {
      console.warn(
        `[mirror] backfillLegacyHandles: lookup failed for mirror_file ${row.id}:`,
        err
      );
    }
  }

  return updated;
}
