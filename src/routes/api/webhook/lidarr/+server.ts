/**
 * Lidarr webhook endpoint.
 *
 * Register this URL in Lidarr under Settings -> Connect -> Webhook:
 *   URL:    http://<tunefetch-host>:3000/api/webhook/lidarr
 *   Method: POST
 *   Events: On Download, On Upgrade
 *
 * No authentication is required (OQ-3, resolved): TuneFetch and Lidarr
 * share the same Docker host and communicate over the internal network.
 *
 * Handles two cases:
 *   eventType=Download, isUpgrade=false -- copy new files to secondary lists
 *   eventType=Download, isUpgrade=true  -- re-copy upgraded files over existing mirrors
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { env } from '$lib/server/env';
import { mirrorTrackFile, remirrorUpgrade } from '$lib/server/mirror';
import { triggerPlexRefreshAndSync } from '$lib/server/plex-sync';

// ── Lidarr webhook payload types ──────────────────────────────────────────────

interface WebhookArtist {
  id: number;
  name: string;
  foreignArtistId: string;
  path?: string;
}

interface WebhookTrackFile {
  id: number;
  path: string;
  relativePath?: string;
  [key: string]: unknown;
}

interface LidarrWebhookPayload {
  eventType: string;
  isUpgrade?: boolean;
  artist?: WebhookArtist;
  trackFiles?: WebhookTrackFile[];
  /** Present on upgrade events -- the files being replaced. */
  deletedFiles?: WebhookTrackFile[];
}

// ── Mirror item row type ──────────────────────────────────────────────────────

interface MirrorCandidate {
  list_item_id: number;
  target_root: string;
}

// ── Upgrade matching ──────────────────────────────────────────────────────────

/**
 * Pair a deletedFile (the file Lidarr just replaced) with its replacement in
 * trackFiles.
 *
 * The previous implementation had `?? trackFiles[0]` as a catch-all which is
 * catastrophic for multi-track upgrades (e.g. an album re-encoded mp3 → flac
 * where every relativePath changes extension). Every iteration would land on
 * trackFiles[0], so all 9 destinations would be overwritten with track 1's
 * content. We now require an explicit match and otherwise return `undefined`
 * so the caller can mark the mirror stale and let the verify pass re-resolve.
 *
 * Match order:
 *   1. Single-track upgrade (1 deleted, 1 new) — trivially the same file.
 *   2. Exact relativePath match.
 *   3. Same filename basename without extension. Compares the basename only
 *      (not the full relative path) so a folder rename on upgrade — e.g.
 *      `AC_DC/T.N.T. (1975)/01-T.N.T.mp3` → `AC_DC/TNT/01-T.N.T.flac` —
 *      still pairs correctly.
 */
function matchUpgradeReplacement(
  oldFile: WebhookTrackFile,
  deletedFiles: WebhookTrackFile[],
  trackFiles: WebhookTrackFile[]
): WebhookTrackFile | undefined {
  if (deletedFiles.length === 1 && trackFiles.length === 1) {
    return trackFiles[0];
  }

  if (oldFile.relativePath) {
    const exact = trackFiles.find((f) => f.relativePath === oldFile.relativePath);
    if (exact) return exact;

    const oldStem = basenameWithoutExtension(oldFile.relativePath);
    const stemMatch = trackFiles.find(
      (f) => f.relativePath && basenameWithoutExtension(f.relativePath) === oldStem
    );
    if (stemMatch) return stemMatch;
  }

  return undefined;
}

/**
 * Return the basename of a path with its final extension removed.
 *
 * Implemented manually rather than via `path.parse` so it's robust to either
 * separator style (Lidarr's relativePath shape isn't guaranteed across hosts)
 * and to multi-dot filenames like `01.Track.Name.flac` (where path.parse's
 * `.name` would still give the right answer, but we want one consistent
 * implementation either way).
 */
function basenameWithoutExtension(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {
  // Verify shared secret when LIDARR_WEBHOOK_SECRET is configured.
  // In Lidarr: Settings -> Connect -> Webhook -> add custom header X-TuneFetch-Secret.
  const expected = env.LIDARR_WEBHOOK_SECRET;
  if (expected) {
    const provided = request.headers.get('x-tunefetch-secret');
    if (provided !== expected) {
      console.warn('[webhook] Rejected request with invalid or missing X-TuneFetch-Secret');
      return json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let payload: LidarrWebhookPayload;
  try {
    payload = await request.json() as LidarrWebhookPayload;
  } catch {
    return json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // Test event -- Lidarr sends this when you first configure the webhook
  if (payload.eventType === 'Test') {
    console.log('[webhook] Lidarr test event received — webhook is reachable.');
    return json({ ok: true, event: 'Test' });
  }

  // Only handle Download events (covers both new downloads and upgrades)
  if (payload.eventType !== 'Download' || !payload.artist) {
    return json({ ok: true, ignored: true, event: payload.eventType });
  }

  const db = getDb();
  const lidarrArtistId = payload.artist.id;
  const trackFiles = payload.trackFiles ?? [];

  // ── Upgrade path ───────────────────────────────────────────────────────────
  // Lidarr replaced an existing file with a higher-quality version.
  // Re-copy from the new file path over every existing mirror.
  if (payload.isUpgrade) {
    const deletedFiles = payload.deletedFiles ?? [];
    const tasks: Promise<void>[] = [];

    for (const oldFile of deletedFiles) {
      const newFile = matchUpgradeReplacement(oldFile, deletedFiles, trackFiles);

      if (newFile) {
        tasks.push(
          remirrorUpgrade(oldFile.path, newFile.path, oldFile.id, newFile.id).catch((err) =>
            console.error(`[webhook] remirror upgrade failed for ${oldFile.path}:`, err)
          )
        );
      } else {
        // No matching new file -- mark existing mirrors as stale (match by
        // trackFileId for stability, fall back to path for legacy rows).
        // The next verify pass will re-resolve the source via Lidarr.
        console.warn(
          `[webhook] No upgrade match for "${oldFile.path}" — marking mirrors stale for next verify.`
        );
        db.prepare(
          `UPDATE mirror_files
              SET status = 'stale', updated_at = CURRENT_TIMESTAMP
            WHERE lidarr_track_file_id = ? OR source_path = ?`
        ).run(oldFile.id, oldFile.path);
      }
    }

    await Promise.allSettled(tasks);

    // Trigger Plex library refresh + delayed sync for affected playlists
    triggerPlexRefreshAndSync(lidarrArtistId, 'webhook');

    return json({ ok: true, event: 'Upgrade', tasks: tasks.length });
  }

  // ── New download path ──────────────────────────────────────────────────────
  // A new file has been acquired for an artist. Copy it into every secondary
  // list that has items for this artist (items whose list's root folder differs
  // from the artist's owning root folder).

  if (trackFiles.length === 0) {
    return json({ ok: true, ignored: true, reason: 'no track files in payload' });
  }

  // Get the owner's root folder for this artist.
  const ownerRow = db
    .prepare('SELECT root_folder_path FROM artist_ownership WHERE lidarr_artist_id = ?')
    .get(lidarrArtistId) as { root_folder_path: string } | undefined;

  if (!ownerRow) {
    // Artist not tracked by TuneFetch -- nothing to mirror.
    return json({ ok: true, ignored: true, reason: 'artist not in artist_ownership' });
  }

  const ownerRoot = ownerRow.root_folder_path;

  // Find list_items belonging to lists with a DIFFERENT root folder than the owner.
  // These are the items that need file copies for the new download.
  const mirrorCandidates = db
    .prepare(
      `SELECT li.id AS list_item_id, l.root_folder_path AS target_root
         FROM list_items li
         JOIN lists l ON l.id = li.list_id
        WHERE li.lidarr_artist_id = ?
          AND l.root_folder_path != ?
          AND li.sync_status IN ('mirror_pending', 'mirror_active', 'mirror_broken', 'synced')`
    )
    .all(lidarrArtistId, ownerRoot) as MirrorCandidate[];

  if (mirrorCandidates.length === 0) {
    return json({ ok: true, mirrors: 0 });
  }

  // Copy each new track file to each secondary list's root folder.
  const tasks: Promise<void>[] = [];

  for (const candidate of mirrorCandidates) {
    for (const trackFile of trackFiles) {
      tasks.push(
        mirrorTrackFile(trackFile.path, candidate.list_item_id, ownerRoot, candidate.target_root, {
          trackFileId: trackFile.id
        })
          .then(() => {
            // Only flip status inside a transaction, and only after confirming
            // an active mirror_files row exists. This prevents a race where two
            // concurrent webhooks for the same artist both see mirror_pending
            // and one of them flips status before the other's copy completes.
            db.transaction(() => {
              const haveActive = db.prepare(
                `SELECT 1 FROM mirror_files
                  WHERE list_item_id = ? AND status = 'active' LIMIT 1`
              ).get(candidate.list_item_id);
              if (haveActive) {
                db.prepare(
                  `UPDATE list_items
                      SET sync_status = 'synced', sync_error = NULL
                    WHERE id = ? AND sync_status = 'mirror_pending'`
                ).run(candidate.list_item_id);
              }
            })();
          })
          .catch((err) => {
            console.error(
              `[webhook] mirror copy failed for list_item ${candidate.list_item_id}:`,
              err
            );
            // Mark the specific mirror_files row as pending so it shows up
            // as needing attention in the health dashboard.
            db.prepare(
              `UPDATE mirror_files
                  SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                WHERE list_item_id = ? AND source_path = ?`
            ).run(candidate.list_item_id, trackFile.path);
          })
      );
    }
  }

  await Promise.allSettled(tasks);

  // Trigger Plex library refresh + delayed sync for affected playlists
  triggerPlexRefreshAndSync(lidarrArtistId, 'webhook');

  return json({
    ok: true,
    event: 'Download',
    mirrors: tasks.length,
    candidates: mirrorCandidates.length
  });
};

