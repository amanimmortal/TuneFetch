/**
 * Lidarr webhook endpoint.
 *
 * Register this URL in Lidarr under Settings → Connect → Webhook:
 *   URL:    http://<tunefetch-host>:3000/api/webhook/lidarr
 *   Method: POST
 *   Events: On Download, On Upgrade
 *
 * No authentication is required (OQ-3, resolved): TuneFetch and Lidarr
 * share the same Docker host and communicate over the internal network.
 *
 * Handles two cases:
 *   eventType=Download, isUpgrade=false → copy new files to secondary lists
 *   eventType=Download, isUpgrade=true  → re-copy upgraded files over existing mirrors
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { mirrorTrackFile, remirrorUpgrade } from '$lib/server/mirror';

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
  /** Present on upgrade events — the files being replaced. */
  deletedFiles?: WebhookTrackFile[];
}

// ── Mirror item row type ──────────────────────────────────────────────────────

interface MirrorCandidate {
  list_item_id: number;
  target_root: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {
  let payload: LidarrWebhookPayload;
  try {
    payload = await request.json() as LidarrWebhookPayload;
  } catch {
    return json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // Test event — Lidarr sends this when you first configure the webhook
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
      // Match the replacement file by relativePath if available, otherwise
      // take the first new track file (single-track upgrades only have one).
      const newFile =
        trackFiles.find(
          (f) =>
            f.relativePath &&
            oldFile.relativePath &&
            f.relativePath === oldFile.relativePath
        ) ?? trackFiles[0];

      if (newFile) {
        tasks.push(
          remirrorUpgrade(oldFile.path, newFile.path).catch((err) =>
            console.error(`[webhook] remirror upgrade failed for ${oldFile.path}:`, err)
          )
        );
      } else {
        // No matching new file — mark existing mirrors as stale
        db.prepare(
          `UPDATE mirror_files
              SET status = 'stale', updated_at = CURRENT_TIMESTAMP
            WHERE source_path = ?`
        ).run(oldFile.path);
      }
    }

    await Promise.allSettled(tasks);
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
    // Artist not tracked by TuneFetch — nothing to mirror.
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
          AND li.sync_status IN ('mirror_pending', 'mirror_active', 'synced')`
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
        mirrorTrackFile(trackFile.path, candidate.list_item_id, ownerRoot, candidate.target_root)
          .then(() => {
            // If the item was waiting for its first file, it's now active.
            db.prepare(
              `UPDATE list_items
                  SET sync_status = 'synced', sync_error = NULL
                WHERE id = ? AND sync_status = 'mirror_pending'`
            ).run(candidate.list_item_id);
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

  return json({
    ok: true,
    event: 'Download',
    mirrors: tasks.length,
    candidates: mirrorCandidates.length
  });
};
