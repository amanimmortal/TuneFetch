import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import schemaSql from './schema.sql?raw';
import { env } from './env';

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
