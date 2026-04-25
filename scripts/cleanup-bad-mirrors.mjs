#!/usr/bin/env node
/**
 * cleanup-bad-mirrors.mjs
 *
 * One-off cleanup for the full-artist mirror bug (mirror-logic-review.md).
 *
 * The bug caused _runBackfill to copy every file by an artist and associate
 * them all with the single list_item_id, regardless of whether the item was
 * a track or album. This script reverses that:
 *
 *   1. Finds all mirror_files rows linked to track/album list_items.
 *   2. Deletes the physical mirror files from disk.
 *   3. Removes those mirror_files rows from the DB.
 *   4. Resets the affected list_items to sync_status='pending' so the
 *      fixed _runBackfill will re-mirror only the correct files.
 *
 * Usage (inside the TuneFetch Docker container):
 *
 *   # Preview — no changes made:
 *   node scripts/cleanup-bad-mirrors.mjs --dry-run
 *
 *   # Apply:
 *   node scripts/cleanup-bad-mirrors.mjs
 *
 * DATA_DIR env var controls the DB/data path (default: /app/data).
 * After running, restart the TuneFetch container to trigger re-backfill.
 */

import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const isDryRun = process.argv.includes('--dry-run');
const dataDir = process.env.DATA_DIR ?? '/app/data';
const dbPath = resolve(dataDir, 'tunefetch.db');

console.log('─'.repeat(60));
console.log('TuneFetch: bad-mirror cleanup');
console.log(`  DB:   ${dbPath}`);
console.log(`  Mode: ${isDryRun ? 'DRY RUN — no changes will be made' : 'LIVE'}`);
console.log('─'.repeat(60));

// ── Open DB ───────────────────────────────────────────────────────────────────

if (!existsSync(dbPath)) {
  console.error(`ERROR: database not found at ${dbPath}`);
  console.error('Set DATA_DIR to match your container volume, e.g.:');
  console.error('  DATA_DIR=/mnt/user/appdata/tunefetch node scripts/cleanup-bad-mirrors.mjs');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Query affected rows ───────────────────────────────────────────────────────

const rows = db.prepare(`
  SELECT
    mf.id           AS mirror_file_id,
    mf.mirror_path,
    mf.list_item_id,
    li.type         AS item_type,
    li.title,
    li.artist_name
  FROM mirror_files mf
  JOIN list_items li ON li.id = mf.list_item_id
  WHERE li.type IN ('track', 'album')
  ORDER BY mf.list_item_id, mf.id
`).all();

if (rows.length === 0) {
  console.log('\nNo mirror_files rows found for track/album items — nothing to clean up.');
  db.close();
  process.exit(0);
}

// Group by list_item for readable output
const byItem = Map.groupBy
  ? Map.groupBy(rows, (r) => r.list_item_id)
  : rows.reduce((m, r) => {
      if (!m.has(r.list_item_id)) m.set(r.list_item_id, []);
      m.get(r.list_item_id).push(r);
      return m;
    }, new Map());

console.log(`\nFound ${rows.length} mirror_files row(s) across ${byItem.size} list_item(s):\n`);

let wouldDeleteFiles = 0;
let wouldSkipMissing = 0;

for (const [itemId, itemRows] of byItem) {
  const first = itemRows[0];
  console.log(`  [list_item ${itemId}] (${first.item_type}) "${first.title}" — ${first.artist_name}`);
  for (const row of itemRows) {
    const exists = existsSync(row.mirror_path);
    const tag = exists ? 'DELETE' : 'missing';
    console.log(`    ${isDryRun ? '[dry-run] ' : ''}${tag}: ${row.mirror_path}`);
    if (exists) wouldDeleteFiles++;
    else wouldSkipMissing++;
  }
}

console.log('');

if (isDryRun) {
  console.log('─'.repeat(60));
  console.log('DRY RUN summary (nothing changed):');
  console.log(`  Physical files that would be deleted : ${wouldDeleteFiles}`);
  console.log(`  Physical files already missing       : ${wouldSkipMissing}`);
  console.log(`  mirror_files rows that would be removed: ${rows.length}`);
  console.log(`  list_items that would be reset to pending: ${byItem.size}`);
  console.log('─'.repeat(60));
  console.log('Re-run without --dry-run to apply.');
  db.close();
  process.exit(0);
}

// ── Delete physical files ─────────────────────────────────────────────────────

let deletedFiles = 0;
let missingFiles = 0;
let fileErrors = 0;

for (const row of rows) {
  if (existsSync(row.mirror_path)) {
    try {
      unlinkSync(row.mirror_path);
      deletedFiles++;
    } catch (err) {
      fileErrors++;
      console.error(`  ERROR deleting ${row.mirror_path}: ${err.message}`);
    }
  } else {
    missingFiles++;
  }
}

// ── Clean DB ──────────────────────────────────────────────────────────────────

const affectedItemIds = [...byItem.keys()];

const cleanup = db.transaction(() => {
  // Remove all mirror_files rows for the affected items
  const del = db.prepare(`
    DELETE FROM mirror_files
    WHERE list_item_id IN (
      SELECT id FROM list_items WHERE type IN ('track', 'album')
    )
  `).run();

  // Reset those list_items so the fixed backfill will re-process them
  const placeholders = affectedItemIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE list_items
    SET sync_status = 'pending', sync_error = NULL
    WHERE id IN (${placeholders})
  `).run(...affectedItemIds);

  return del.changes;
});

const deletedRows = cleanup();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('─'.repeat(60));
console.log('Cleanup complete:');
console.log(`  Physical files deleted                : ${deletedFiles}`);
console.log(`  Physical files already missing        : ${missingFiles}`);
if (fileErrors > 0) {
  console.log(`  Physical files with errors (see above): ${fileErrors}`);
}
console.log(`  mirror_files rows removed from DB     : ${deletedRows}`);
console.log(`  list_items reset to 'pending'         : ${affectedItemIds.length}`);
console.log('─'.repeat(60));
console.log('Next step: restart the TuneFetch container.');
console.log('The orchestrator will pick up the pending items and re-backfill');
console.log('them correctly using the patched mirror logic.');

db.close();
