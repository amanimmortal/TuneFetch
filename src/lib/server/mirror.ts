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
import { dirname, relative, join, basename, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import {
  getTrackFiles,
  getTracks,
  LidarrError,
  type LidarrTrack,
  type LidarrTrackFile,
  getLidarrPrimaryRoot
} from './lidarr';
import { triggerPlexRefreshAndSync } from './plex-sync';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Mirror scope — determines which files should be mirrored for a list_item.
 *
 * In the single-root architecture, Lidarr manages one root folder and
 * secondary lists mirror only the files matching their scope:
 *   - `artist`: all files for the artist (full mirror)
 *   - `album`:  only files belonging to the specific album
 *   - `track`:  only the single file for the specific track
 */
export interface MirrorScope {
  type: 'artist' | 'album' | 'track';
  lidarrAlbumId?: number;
  lidarrTrackId?: number;
}

/**
 * Filter track files to only those within the given scope.
 *
 * - `artist` → all files (no filter)
 * - `album`  → files with matching albumId
 * - `track`  → the single file corresponding to the track's trackFileId
 *
 * For track scoping, `allTracks` must be provided so we can resolve
 * lidarrTrackId → trackFileId. Falls back to album scope if the track
 * can't be resolved, and to full artist if the album can't be resolved.
 */
export function filterTrackFilesByScope(
  allTrackFiles: LidarrTrackFile[],
  scope: MirrorScope,
  allTracks?: LidarrTrack[]
): LidarrTrackFile[] {
  if (scope.type === 'artist') {
    return allTrackFiles;
  }

  if (scope.type === 'track' && scope.lidarrTrackId != null && allTracks) {
    const track = allTracks.find((t) => t.id === scope.lidarrTrackId);
    const trackFileId = track?.trackFileId;
    if (trackFileId && trackFileId > 0) {
      const file = allTrackFiles.filter((f) => f.id === trackFileId);
      if (file.length > 0) return file;
    }
    // Track's file not found — fall back to album scope if we have albumId.
    // This handles the case where the track is known but its file hasn't
    // been downloaded yet, or the trackFileId mapping is stale.
    if (scope.lidarrAlbumId != null) {
      console.log(
        `[mirror] filterTrackFilesByScope: track ${scope.lidarrTrackId} file not found, ` +
        `falling back to album ${scope.lidarrAlbumId} scope`
      );
      return allTrackFiles.filter((f) => f.albumId === scope.lidarrAlbumId);
    }
    // No album fallback available — return empty (caller handles mirror_pending)
    return [];
  }

  if ((scope.type === 'album' || scope.type === 'track') && scope.lidarrAlbumId != null) {
    return allTrackFiles.filter((f) => f.albumId === scope.lidarrAlbumId);
  }

  // Scope IDs missing — can't filter, return all as safest fallback.
  // This happens for legacy items where lidarr_album_id/lidarr_track_id wasn't set.
  console.warn(
    `[mirror] filterTrackFilesByScope: scope type=${scope.type} but no scope IDs set, ` +
    `returning all ${allTrackFiles.length} files`
  );
  return allTrackFiles;
}

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
  /** Joined from list_items at query time so the resolver doesn't need a per-row DB lookup. */
  lidarr_artist_id: number | null;
}

/** SELECT clause for fetching a MirrorRow with the artist id joined in. */
const MIRROR_ROW_SELECT = `
  SELECT mf.id, mf.list_item_id, mf.source_path, mf.mirror_path, mf.status,
         mf.lidarr_track_file_id, mf.lidarr_track_id,
         li.lidarr_artist_id
    FROM mirror_files mf
    LEFT JOIN list_items li ON li.id = mf.list_item_id
`;

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
 * Creates all intermediate directories. Writes to a uniquely-suffixed temp
 * file alongside the destination, then renames it into place so a partial
 * write never leaves a corrupt destination file.
 *
 * The temp suffix includes pid + random bytes so concurrent writers targeting
 * the same destination (e.g. two verify passes that both think a destination
 * is missing) don't collide on the same temp path. Without uniqueness, the
 * second writer's rename races against the first writer's rename and produces
 * spurious ENOENT errors when the temp it expects has already been consumed.
 *
 * The `finally` block unlinks the temp on every exit path so a failure mid-
 * copy never leaves orphan `.tunefetch.<pid>.<hex>.tmp` files alongside user
 * media. On success the rename has already consumed the temp, so the unlink
 * is a no-op (suppressed).
 *
 * Throws on any filesystem error.
 */
export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  await fs.mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tunefetch.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.copyFile(sourcePath, tmp);
    await fs.rename(tmp, destPath);
  } finally {
    await fs.unlink(tmp).catch(() => {}); // no-op on success (rename consumed it)
  }
}

// ── Self-healing source resolution ────────────────────────────────────────────

/**
 * Per-run cache of Lidarr track-file and track lookups, keyed by artistId.
 *
 * When the verifier or a self-heal is processing many rows for the same
 * artist, this avoids hammering Lidarr with one request per file. Callers
 * control the cache's lifetime — a single backfill or verify pass shares
 * one context, but unrelated calls always start fresh and see current
 * Lidarr state.
 */
export interface ResolveContext {
  trackFiles: Map<number, Promise<LidarrTrackFile[]>>;
  tracks: Map<number, Promise<LidarrTrack[]>>;
}

export function newResolveContext(): ResolveContext {
  return { trackFiles: new Map(), tracks: new Map() };
}

function getTrackFilesCached(
  artistId: number,
  ctx: ResolveContext
): Promise<LidarrTrackFile[]> {
  let p = ctx.trackFiles.get(artistId);
  if (!p) {
    p = getTrackFiles(artistId);
    ctx.trackFiles.set(artistId, p);
  }
  return p;
}

function getTracksCached(
  artistId: number,
  ctx: ResolveContext
): Promise<LidarrTrack[]> {
  let p = ctx.tracks.get(artistId);
  if (!p) {
    p = getTracks(artistId);
    ctx.tracks.set(artistId, p);
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
  ctx: ResolveContext
): Promise<string | null> {
  // Artist id is joined into MirrorRow at query time, so no per-row DB hit.
  if (row.lidarr_artist_id == null) {
    return null;
  }
  const artistId = row.lidarr_artist_id;
  const db = getDb();

  let trackFiles: LidarrTrackFile[];
  try {
    trackFiles = await getTrackFilesCached(artistId, ctx);
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
      tracks = await getTracksCached(artistId, ctx);
    } catch {
      tracks = [];
    }
    const track = tracks.find((t) => t.id === row.lidarr_track_id);
    const newTrackFileId = track?.trackFileId;
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
  ctx: ResolveContext
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
    fresh = await resolveCurrentSourcePath(row, ctx);
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

  // Heal only the source_path. The mirror_path stays where it was originally
  // computed (via buildMirrorPath at mirror time, with proper ownerRoot /
  // targetRoot). Trying to "follow" a Lidarr rename from inside the heal path
  // is fragile — we don't have ownerRoot here, and any path-arithmetic we do
  // risks producing a relative path or a wrong remap. Re-mirroring under a
  // new layout is a separate, intentional operation.
  try {
    await copyFile(sourcePath, row.mirror_path);
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
  targetRoot: string,
  scope: MirrorScope
): Promise<void> {
  const job = _runBackfill(lidarrArtistId, listItemId, ownerRoot, targetRoot, scope);
  _activeJobs.add(job);
  job.finally(() => _activeJobs.delete(job)).catch(() => {});
  return job;
}

async function _runBackfill(
  lidarrArtistId: number,
  listItemId: number,
  ownerRoot: string,
  targetRoot: string,
  scope: MirrorScope
): Promise<void> {
  const db = getDb();

  console.log(
    `[mirror] backfill start — listItem=${listItemId} lidarrArtist=${lidarrArtistId} ` +
    `scope=${scope.type} target="${targetRoot}"`
  );

  db.prepare(
    `UPDATE list_items SET sync_status = 'mirror_active', sync_error = NULL WHERE id = ?`
  ).run(listItemId);

  try {
    // Fail fast with a human-readable message if the mount point isn't writable.
    await checkWritable(targetRoot);

    // Sanity check that the list_item still exists.
    const listItem = db
      .prepare('SELECT type FROM list_items WHERE id = ?')
      .get(listItemId) as { type: 'artist' | 'album' | 'track' } | undefined;

    if (!listItem) {
      throw new Error(`list_item ${listItemId} not found — was it deleted mid-backfill?`);
    }

    const allTrackFiles = await getTrackFiles(lidarrArtistId);

    // One getTracks call per backfill — used to build the trackFileId →
    // trackId map so each mirrorTrackFile gets both stable handles, AND
    // to resolve track-level scope (lidarrTrackId → trackFileId).
    // Failure is non-fatal for handle mapping but critical for track scoping.
    let allTracks: LidarrTrack[] = [];
    const fileToTrackId = new Map<number, number>();
    try {
      allTracks = await getTracks(lidarrArtistId);
      for (const t of allTracks) {
        const tfid = t.trackFileId;
        if (tfid && tfid > 0) {
          fileToTrackId.set(tfid, t.id);
        }
      }
    } catch (err) {
      console.warn(`[mirror] backfill listItem=${listItemId}: getTracks failed (non-fatal):`, err);
    }

    // Apply scope filtering — only mirror files that match the item's type.
    const trackFiles = filterTrackFilesByScope(allTrackFiles, scope, allTracks);

    console.log(
      `[mirror] backfill listItem=${listItemId} (${listItem.type}): ` +
      `scope=${scope.type} — ${trackFiles.length} of ${allTrackFiles.length} file(s) in scope`
    );

    if (trackFiles.length === 0) {
      // No files in scope yet — stay mirror_pending.
      // For scoped items (track/album), the album may not be downloaded yet;
      // the webhook will handle copies when Lidarr acquires the files.
      db.prepare(
        `UPDATE list_items SET sync_status = 'mirror_pending' WHERE id = ?`
      ).run(listItemId);
      console.log(
        `[mirror] backfill listItem=${listItemId}: no files in scope yet → mirror_pending` +
        (allTrackFiles.length > 0 ? ` (${allTrackFiles.length} total artist files exist but outside scope)` : '')
      );
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

    // If we copied anything (even partially), tell Plex to rescan so the new
    // files become visible to playlist sync. One trigger per backfill run —
    // the helper handles per-section refresh and dedups delayed sync timers.
    if (successCount > 0) {
      triggerPlexRefreshAndSync(lidarrArtistId, 'mirror.backfill');
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
    .prepare(`${MIRROR_ROW_SELECT} WHERE mf.status = 'stale'`)
    .all() as MirrorRow[];

  // One shared resolve context for the whole batch — many rows for the same
  // artist hit Lidarr (track files + tracks) only once.
  const ctx = newResolveContext();

  // Collect the unique artists whose files we're about to re-copy and tell
  // Plex to rescan once per artist. We fire these now (rather than per-job)
  // so we don't hit Plex with one HTTP call per stale file. The refresh
  // helper queues a delayed sync with a 30s+ backoff, which gives the async
  // copy jobs time to land before Plex sync looks for the files.
  const dirtyArtists = new Set<number>();

  for (const row of staleRows) {
    if (row.lidarr_artist_id != null) dirtyArtists.add(row.lidarr_artist_id);
    const job = _refreshSingleStale(row, ctx);
    _activeJobs.add(job);
    job.finally(() => _activeJobs.delete(job)).catch(() => {});
  }

  for (const artistId of dirtyArtists) {
    triggerPlexRefreshAndSync(artistId, 'mirror.refreshStale');
  }

  return staleRows.length;
}

async function _refreshSingleStale(row: MirrorRow, ctx: ResolveContext): Promise<void> {
  const db = getDb();
  const result = await copyWithHealing(row, row.mirror_path, ctx);

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
  /** New mirror_files rows created during the discover-new pass. */
  discovered: number;
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
 * Then a discover-new pass: for each (list_item, target_root) with mirror
 * candidates, fetch the artist's current trackFiles and create rows + copies
 * for any files that aren't yet mirrored. This is the safety net that catches
 * any webhook event that was missed and keeps the secondary list a complete
 * mirror of the artist regardless of which path triggered the work.
 *
 * Runs after the orphan scan. Safe to invoke ad-hoc; uses an internal
 * track-file cache so per-artist Lidarr calls happen at most once per run.
 *
 * The user can run this as often as they like — calls are entirely against
 * a local Lidarr instance and the local filesystem.
 */
export async function verifyMirrorFiles(): Promise<VerifyReport> {
  const db = getDb();
  const ctx = newResolveContext();
  const report: VerifyReport = {
    scanned: 0,
    pathsHealed: 0,
    filesRecopied: 0,
    unresolvable: 0,
    errors: 0,
    discovered: 0
  };

  // Track artists whose mirror trees we touched (recopied content or added
  // new files). One Plex refresh + delayed sync per artist after the pass
  // completes — keeps the load on Plex bounded even if the verify pass
  // touches thousands of files.
  const dirtyArtists = new Set<number>();

  // ORDER BY list_item_id keeps rows for the same artist contiguous, which
  // maximizes the cache hit rate as we walk the table.
  const rows = db
    .prepare(`${MIRROR_ROW_SELECT} ORDER BY mf.list_item_id`)
    .all() as MirrorRow[];

  for (const row of rows) {
    report.scanned++;
    try {
      // First confirm what Lidarr currently says about this file.
      const fresh = await resolveCurrentSourcePath(row, ctx);
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
      const currentMirror = row.mirror_path;
      if (fresh !== currentSource) {
        // Heal source_path only; leave mirror_path alone (see copyWithHealing
        // for rationale — we don't have ownerRoot/targetRoot here to safely
        // remap, and re-arranging the mirror tree is out of scope for verify).
        db.prepare(
          `UPDATE mirror_files
              SET source_path = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(fresh, row.id);
        currentSource = fresh;
        report.pathsHealed++;
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
          if (row.lidarr_artist_id != null) dirtyArtists.add(row.lidarr_artist_id);
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

  // ── Discover-new pass ───────────────────────────────────────────────────────
  // Find any artist files Lidarr currently has that aren't yet mirrored under
  // a list that wants them. Targets list_items already in a mirror sync_status.
  // Now scope-aware: only discovers files matching the item's type (artist/album/track).
  const primaryRoot = await getLidarrPrimaryRoot();

  const candidates = db
    .prepare(
      `SELECT li.id            AS list_item_id,
              li.lidarr_artist_id,
              li.type,
              li.lidarr_album_id,
              li.lidarr_track_id,
              l.root_folder_path  AS target_root
         FROM list_items li
         JOIN lists l            ON l.id = li.list_id
        WHERE li.lidarr_artist_id IS NOT NULL
          AND l.root_folder_path != ?
          AND li.sync_status IN ('mirror_pending','mirror_active','mirror_broken','synced')`
    )
    .all(primaryRoot) as Array<{
      list_item_id: number;
      lidarr_artist_id: number;
      type: 'artist' | 'album' | 'track';
      lidarr_album_id: number | null;
      lidarr_track_id: number | null;
      target_root: string;
    }>;

  // Per-artist cache of tracks (for scope resolution and trackFileId → trackId map).
  // The underlying getTracksCached call is already deduped by artist via
  // ResolveContext, but we cache the derived data here to avoid re-iterating.
  const trackIdMapByArtist = new Map<number, Map<number, number>>();
  const tracksByArtist = new Map<number, LidarrTrack[]>();
  const getArtistTracks = async (artistId: number): Promise<{ tracks: LidarrTrack[]; trackMap: Map<number, number> }> => {
    let tracks = tracksByArtist.get(artistId);
    let trackMap = trackIdMapByArtist.get(artistId);
    if (tracks && trackMap) return { tracks, trackMap };
    tracks = [];
    trackMap = new Map<number, number>();
    try {
      tracks = await getTracksCached(artistId, ctx);
      for (const t of tracks) {
        const tfid = t.trackFileId;
        if (tfid && tfid > 0) trackMap.set(tfid, t.id);
      }
    } catch {
      // non-fatal — proceed with trackFileId only
    }
    tracksByArtist.set(artistId, tracks);
    trackIdMapByArtist.set(artistId, trackMap);
    return { tracks, trackMap };
  };

  // Insert a pending mirror_files row for a failed copy. Wrapped in its own
  // try/catch so a transient DB error (constraint violation, locked db,
  // future schema drift) doesn't escape the discover-new loop and abort the
  // whole verify run — the row is a "best effort to retry next time"
  // breadcrumb, not load-bearing.
  const recordPendingDiscovery = (
    listItemId: number,
    sourcePath: string,
    mirrorPath: string,
    trackFileId: number,
    trackId: number | undefined,
    errorMsg: string
  ): void => {
    try {
      db.prepare(
        `INSERT INTO mirror_files
           (list_item_id, source_path, mirror_path, status,
            lidarr_track_file_id, lidarr_track_id, last_error)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`
      ).run(listItemId, sourcePath, mirrorPath, trackFileId, trackId ?? null, errorMsg);
    } catch (insertErr) {
      console.warn(
        `[mirror] verify discover-new: failed to record pending row for list_item ${listItemId} ` +
        `(${sourcePath}):`,
        insertErr
      );
    }
  };

  for (const c of candidates) {
    let allTrackFiles: LidarrTrackFile[];
    try {
      allTrackFiles = await getTrackFilesCached(c.lidarr_artist_id, ctx);
    } catch (err) {
      console.warn(
        `[mirror] verify discover-new: getTrackFiles failed for artist ${c.lidarr_artist_id} ` +
        `(list_item ${c.list_item_id}):`,
        err
      );
      report.errors++;
      continue;
    }
    if (allTrackFiles.length === 0) continue;

    // Scope-filter: only discover files matching this item's type.
    const { tracks: artistTracks, trackMap } = await getArtistTracks(c.lidarr_artist_id);
    const scope: MirrorScope = {
      type: c.type,
      lidarrAlbumId: c.lidarr_album_id ?? undefined,
      lidarrTrackId: c.lidarr_track_id ?? undefined
    };
    const trackFiles = filterTrackFilesByScope(allTrackFiles, scope, artistTracks);

    // What does this list_item already have rows for? Match by trackFileId
    // (stable) with a fallback to source_path for legacy rows.
    const existing = db
      .prepare(
        `SELECT lidarr_track_file_id, source_path
           FROM mirror_files
          WHERE list_item_id = ?`
      )
      .all(c.list_item_id) as Array<{
        lidarr_track_file_id: number | null;
        source_path: string;
      }>;
    const knownTrackFileIds = new Set(
      existing
        .map((r) => r.lidarr_track_file_id)
        .filter((v): v is number => v != null)
    );
    const knownSourcePaths = new Set(existing.map((r) => r.source_path));

    for (const file of trackFiles) {
      if (knownTrackFileIds.has(file.id) || knownSourcePaths.has(file.path)) continue;
      try {
        // Owner root is always the Lidarr primary root in the single-root
        // architecture — the SELECT above only joins target_root, so we use
        // the primaryRoot variable resolved at the top of this pass.
        await mirrorTrackFile(file.path, c.list_item_id, primaryRoot, c.target_root, {
          trackFileId: file.id,
          trackId: trackMap.get(file.id)
        });
        report.discovered++;
        dirtyArtists.add(c.lidarr_artist_id);
        console.log(
          `[mirror] verify discover-new: copied missing file for list_item ${c.list_item_id} ` +
          `(scope=${c.type}, ${file.path})`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[mirror] verify discover-new: failed to mirror ${file.path} for list_item ${c.list_item_id}:`,
          err
        );
        recordPendingDiscovery(
          c.list_item_id,
          file.path,
          buildMirrorPath(file.path, primaryRoot, c.target_root),
          file.id,
          trackMap.get(file.id),
          msg
        );
        report.errors++;
      }
    }
  }

  // Tell Plex to rescan for any artist whose mirror tree we touched (recopied
  // an existing file or discovered a new one). Done once per artist at the
  // end of the pass so a verify run that touches thousands of files results
  // in at most one refresh per affected library section.
  for (const artistId of dirtyArtists) {
    triggerPlexRefreshAndSync(artistId, 'mirror.verify');
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
  const ctx = newResolveContext();

  const rows = db
    .prepare(
      `${MIRROR_ROW_SELECT}
        WHERE mf.lidarr_track_file_id IS NULL
          AND li.lidarr_artist_id IS NOT NULL`
    )
    .all() as MirrorRow[];

  let updated = 0;
  for (const row of rows) {
    if (row.lidarr_artist_id == null) continue; // belt-and-braces with the WHERE clause
    try {
      const trackFiles = await getTrackFilesCached(row.lidarr_artist_id, ctx);
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

// ── Prune out-of-scope mirrors ────────────────────────────────────────────────

/**
 * Remove mirror_files rows (and their physical files) that don't match their
 * parent list_item's scope.
 *
 * After migrating from full-artist mirroring to scoped mirroring, there will
 * be mirror_files rows that were created for the entire artist but the parent
 * list_item only wanted a single track or album. This function identifies
 * and removes those out-of-scope rows.
 *
 * For each mirror_files row:
 *   1. Load the parent list_item's type, lidarr_album_id, lidarr_track_id
 *   2. If type = 'artist', the row is always in scope (skip)
 *   3. For album items: check if the row's track file belongs to the album
 *   4. For track items: check if the row's track file matches the track
 *   5. If out of scope → delete the physical file + DB row
 *
 * Groups by artist for efficient Lidarr API usage.
 */
export async function pruneOutOfScopeMirrors(): Promise<{
  pruned: number;
  errors: number;
}> {
  const db = getDb();
  const report = { pruned: 0, errors: 0 };

  console.log('[mirror] pruneOutOfScopeMirrors: starting...');

  // Find all mirror_files rows whose parent list_item is track or album scoped.
  // Artist-scoped items keep everything, so no pruning needed.
  const rows = db
    .prepare(
      `SELECT mf.id, mf.mirror_path, mf.lidarr_track_file_id,
              li.id AS list_item_id, li.type, li.lidarr_artist_id,
              li.lidarr_album_id, li.lidarr_track_id
         FROM mirror_files mf
         JOIN list_items li ON li.id = mf.list_item_id
        WHERE li.type IN ('album', 'track')
          AND mf.status != 'pending'`
    )
    .all() as Array<{
      id: number;
      mirror_path: string;
      lidarr_track_file_id: number | null;
      list_item_id: number;
      type: 'album' | 'track';
      lidarr_artist_id: number | null;
      lidarr_album_id: number | null;
      lidarr_track_id: number | null;
    }>;

  if (rows.length === 0) {
    console.log('[mirror] pruneOutOfScopeMirrors: no scoped mirror rows to check.');
    return report;
  }

  // Cache track files and tracks per artist to avoid redundant Lidarr calls.
  const trackFileCache = new Map<number, LidarrTrackFile[]>();
  const tracksCache = new Map<number, LidarrTrack[]>();

  const getArtistData = async (artistId: number) => {
    if (!trackFileCache.has(artistId)) {
      try {
        trackFileCache.set(artistId, await getTrackFiles(artistId));
      } catch {
        trackFileCache.set(artistId, []);
      }
    }
    if (!tracksCache.has(artistId)) {
      try {
        tracksCache.set(artistId, await getTracks(artistId));
      } catch {
        tracksCache.set(artistId, []);
      }
    }
    return {
      trackFiles: trackFileCache.get(artistId)!,
      tracks: tracksCache.get(artistId)!
    };
  };

  for (const row of rows) {
    if (!row.lidarr_artist_id) continue;

    try {
      const { trackFiles: allTrackFiles, tracks: allTracks } =
        await getArtistData(row.lidarr_artist_id);

      const scope: MirrorScope = {
        type: row.type,
        lidarrAlbumId: row.lidarr_album_id ?? undefined,
        lidarrTrackId: row.lidarr_track_id ?? undefined
      };
      const inScopeFiles = filterTrackFilesByScope(allTrackFiles, scope, allTracks);
      const inScopeIds = new Set(inScopeFiles.map((f) => f.id));

      // If this mirror row's track file ID is NOT in the scoped set, prune it.
      // Legacy rows may not have a lidarr_track_file_id; we keep them but log that they
      // could not be evaluated against the current scope.
      if (row.lidarr_track_file_id == null) {
        console.info(
          `[mirror] pruneOutOfScopeMirrors: skipping mirror row ${row.id} with null lidarr_track_file_id (legacy row; cannot verify scope)`
        );
      } else if (!inScopeIds.has(row.lidarr_track_file_id)) {
        // Delete physical file (best-effort)
        try {
          await fs.unlink(row.mirror_path);
        } catch (unlinkErr) {
          // File already gone or inaccessible — that's fine, still remove the row.
          if (
            unlinkErr instanceof Error &&
            'code' in unlinkErr &&
            (unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            console.warn(
              `[mirror] pruneOutOfScopeMirrors: unlink failed for ${row.mirror_path}:`,
              unlinkErr
            );
          }
        }

        db.prepare('DELETE FROM mirror_files WHERE id = ?').run(row.id);
        report.pruned++;
      }
    } catch (err) {
      console.warn(
        `[mirror] pruneOutOfScopeMirrors: error processing mirror_file ${row.id}:`,
        err
      );
      report.errors++;
    }
  }

  console.log(
    `[mirror] pruneOutOfScopeMirrors: done. pruned=${report.pruned} errors=${report.errors} ` +
    `(checked ${rows.length} scoped mirror rows)`
  );
  return report;
}

// ── One-shot repair for corrupted mirror_paths ────────────────────────────────


