import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import schemaSql from './schema.sql?raw';
import { env } from './env';
import { encrypt, isEncrypted } from './crypto';

let _db: Database.Database | null = null;

/**
 * Return the singleton SQLite connection.
 *
 * The database file lives under env.DATA_DIR (default `/app/data`).
 * On first call we create the directory if needed, open the DB,
 * enable WAL + foreign keys, and run the schema (all statements are
 * idempotent — `CREATE TABLE IF NOT EXISTS`).
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolve(env.DATA_DIR, 'tunefetch.db');
  mkdirSync(env.DATA_DIR, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);

  // ── Safe migrations ──────────────────────────────────────────────────────
  // Add columns that were introduced after initial schema without breaking
  // existing databases. SQLite does not support IF NOT EXISTS on ALTER TABLE.
  const listItemCols = (db.pragma('table_info(list_items)') as Array<{ name: string }>)
    .map((c) => c.name);
  if (!listItemCols.includes('artist_mbid')) {
    db.exec('ALTER TABLE list_items ADD COLUMN artist_mbid TEXT');
  }

  const listCols = (db.pragma('table_info(lists)') as Array<{ name: string }>)
    .map((c) => c.name);
  if (!listCols.includes('quality_profile_id')) {
    db.exec('ALTER TABLE lists ADD COLUMN quality_profile_id INTEGER');
  }
  if (!listCols.includes('metadata_profile_id')) {
    db.exec('ALTER TABLE lists ADD COLUMN metadata_profile_id INTEGER');
  }

  // Migration: library_section_id moved from global settings to per-user mapping
  const plexMappingCols = (db.pragma('table_info(plex_user_mappings)') as Array<{ name: string }>)
    .map((c) => c.name);
  if (!plexMappingCols.includes('library_section_id')) {
    db.exec("ALTER TABLE plex_user_mappings ADD COLUMN library_section_id TEXT NOT NULL DEFAULT ''");
  }

  // ── Migrate artist_ownership: add ON DELETE SET NULL to owner_list_id FK ──
  // SQLite does not support ALTER TABLE ... ALTER COLUMN, so we recreate the
  // table if the FK is still NO ACTION (pre-P2-1 schema).
  {
    const fkList = db.prepare("PRAGMA foreign_key_list(artist_ownership)").all() as Array<{
      from: string; on_delete: string;
    }>;
    const ownerFk = fkList.find((c) => c.from === 'owner_list_id');
    if (ownerFk && ownerFk.on_delete !== 'SET NULL') {
      db.exec(`
        BEGIN;
        CREATE TABLE artist_ownership_new (
          id               INTEGER PRIMARY KEY,
          artist_mbid      TEXT NOT NULL UNIQUE,
          lidarr_artist_id INTEGER NOT NULL,
          owner_list_id    INTEGER REFERENCES lists(id) ON DELETE SET NULL,
          root_folder_path TEXT NOT NULL,
          created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO artist_ownership_new SELECT * FROM artist_ownership;
        DROP TABLE artist_ownership;
        ALTER TABLE artist_ownership_new RENAME TO artist_ownership;
        COMMIT;
      `);
    }
  }

  // ── Encrypt existing plaintext Plex tokens ───────────────────────────────
  // If plex_user_mappings or plex_playlists have plaintext tokens (pre-P1-4),
  // encrypt them now. Rows already starting with 'enc1:' are skipped.
  const mappingRows = db
    .prepare('SELECT id, plex_user_token FROM plex_user_mappings')
    .all() as Array<{ id: number; plex_user_token: string }>;
  for (const row of mappingRows) {
    if (!isEncrypted(row.plex_user_token)) {
      db.prepare('UPDATE plex_user_mappings SET plex_user_token = ? WHERE id = ?')
        .run(encrypt(row.plex_user_token), row.id);
    }
  }

  const playlistRows = db
    .prepare('SELECT id, plex_user_token FROM plex_playlists')
    .all() as Array<{ id: number; plex_user_token: string }>;
  for (const row of playlistRows) {
    if (!isEncrypted(row.plex_user_token)) {
      db.prepare('UPDATE plex_playlists SET plex_user_token = ? WHERE id = ?')
        .run(encrypt(row.plex_user_token), row.id);
    }
  }

  _db = db;
  return db;
}

/** Close the database connection (used in tests / graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
