import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import schemaSql from './schema.sql?raw';
import { env } from './env';
import { encrypt, decrypt, isEncrypted } from './crypto';

let _db: Database.Database | null = null;

/**
 * Return the singleton SQLite connection.
 *
 * The database file lives under env.DATA_DIR (default `/app/data`).
 * On first call we create the directory if needed, open the DB,
 * enable WAL + foreign keys, and run the schema (all statements are
 * idempotent -- CREATE TABLE IF NOT EXISTS).
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolve(env.DATA_DIR, 'tunefetch.db');
  mkdirSync(env.DATA_DIR, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);

  // Safe migrations: add columns introduced after initial schema.
  // SQLite does not support IF NOT EXISTS on ALTER TABLE.
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

  // Migration: library_section_id moved from global settings to per-user mapping.
  const plexMappingCols = (db.pragma('table_info(plex_user_mappings)') as Array<{ name: string }>)
    .map((c) => c.name);
  if (!plexMappingCols.includes('library_section_id')) {
    db.exec("ALTER TABLE plex_user_mappings ADD COLUMN library_section_id TEXT NOT NULL DEFAULT ''");
  }
  // Migration: plex_user_id stores the numeric plex.tv home user ID so we can
  // fetch a fresh switch token at sync time (switch tokens are short-lived).
  if (!plexMappingCols.includes('plex_user_id')) {
    db.exec('ALTER TABLE plex_user_mappings ADD COLUMN plex_user_id INTEGER');
  }

  // Migrate artist_ownership: add ON DELETE SET NULL to owner_list_id FK.
  // SQLite does not support ALTER TABLE ... ALTER COLUMN, so recreate if needed.
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

  // Encrypt existing plaintext Plex tokens (pre-P1-4 rows).
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

  // Repair double-encrypted plex_playlists tokens.
  // The old create_playlist_link path sent the already-encrypted mapping token
  // through the client and then encrypted it again server-side. Peel one layer:
  // if decrypting a token yields another enc1: string, write the inner value back.
  // This is idempotent once all rows are correct.
  {
    const rows2 = db
      .prepare('SELECT id, plex_user_token FROM plex_playlists')
      .all() as Array<{ id: number; plex_user_token: string }>;
    for (const r of rows2) {
      if (!isEncrypted(r.plex_user_token)) continue;
      let inner: string;
      try {
        inner = decrypt(r.plex_user_token);
      } catch {
        continue;
      }
      if (isEncrypted(inner)) {
        db.prepare('UPDATE plex_playlists SET plex_user_token = ? WHERE id = ?')
          .run(inner, r.id);
        console.log(`[migration] Peeled double-encrypted token on plex_playlists row ${r.id}`);
      }
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
