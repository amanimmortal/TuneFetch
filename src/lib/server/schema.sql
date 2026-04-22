-- TuneFetch schema (see REQUIREMENTS.md Section 5)
-- This file is executed on startup; every statement must be idempotent.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Single admin user (may expand in future).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Server-side sessions. Session id is a random token stored in an
-- HTTP-only cookie. Sessions expire via expires_at.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Lists map to people and to Lidarr root folders.
CREATE TABLE IF NOT EXISTS lists (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  root_folder_path    TEXT NOT NULL,
  quality_profile_id  INTEGER,
  metadata_profile_id INTEGER,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Items added to lists by users.
CREATE TABLE IF NOT EXISTS list_items (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  mbid             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('track', 'album', 'artist')),
  title            TEXT NOT NULL,
  artist_name      TEXT NOT NULL,
  album_name       TEXT,
  -- For track/album items: the MB artist MBID so the orchestrator can auto-add
  -- the artist to Lidarr (unmonitored) when it is not already present.
  artist_mbid      TEXT,
  lidarr_artist_id INTEGER,
  lidarr_album_id  INTEGER,
  lidarr_track_id  INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'pending'
                   CHECK(sync_status IN ('pending','synced','failed','mirror_pending','mirror_active','mirror_broken')),
  sync_error       TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_list_items_mbid ON list_items(mbid);

-- Tracks which list "owns" each artist in Lidarr.
CREATE TABLE IF NOT EXISTS artist_ownership (
  id               INTEGER PRIMARY KEY,
  artist_mbid      TEXT NOT NULL UNIQUE,
  lidarr_artist_id INTEGER NOT NULL,
  owner_list_id    INTEGER NOT NULL REFERENCES lists(id),
  root_folder_path TEXT NOT NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- File copies created by TuneFetch for secondary-list items (OQ-7 resolved).
CREATE TABLE IF NOT EXISTS mirror_files (
  id           INTEGER PRIMARY KEY,
  list_item_id INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  source_path  TEXT NOT NULL,
  mirror_path  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','active','stale')),
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mirror_files_list_item ON mirror_files(list_item_id);
CREATE INDEX IF NOT EXISTS idx_mirror_files_source ON mirror_files(source_path);

-- App-wide configuration (key-value store for settings page).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Orphan files found by the scheduled scan.
-- A file is an orphan if it exists under a secondary (mirror) root folder
-- but has no corresponding mirror_files record.
-- Records are replaced on each scan run.
CREATE TABLE IF NOT EXISTS orphan_files (
  id          INTEGER PRIMARY KEY,
  file_path   TEXT NOT NULL UNIQUE,
  root_folder TEXT NOT NULL,
  found_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Maps Lidarr root folder paths to Plex managed users.
-- A user in Plex maps to a root folder in Lidarr (e.g. "Ben" → /mnt/music/ben).
-- This bridge lets TuneFetch know which Plex user should receive playlists
-- for lists that target a specific root folder path.
CREATE TABLE IF NOT EXISTS plex_user_mappings (
  id                INTEGER PRIMARY KEY,
  root_folder_path  TEXT NOT NULL UNIQUE,
  plex_user_name    TEXT NOT NULL,
  plex_user_token   TEXT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Links a TuneFetch list to a Plex playlist for a specific user.
-- A single list can have multiple plex_playlists rows (different users),
-- and a single user can have multiple playlists from different lists.
CREATE TABLE IF NOT EXISTS plex_playlists (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  plex_user_token  TEXT NOT NULL,
  plex_user_name   TEXT NOT NULL,
  plex_playlist_id TEXT,          -- null until first sync creates it in Plex
  playlist_title   TEXT NOT NULL,
  last_synced_at   DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plex_playlists_list ON plex_playlists(list_id);

-- Tracks which list items have been successfully synced to which Plex playlists.
-- Stores the Plex ratingKey so subsequent syncs skip already-added tracks,
-- and the playlistItemID so items can be surgically removed.
CREATE TABLE IF NOT EXISTS plex_playlist_items (
  id                    INTEGER PRIMARY KEY,
  plex_playlist_id_fk   INTEGER NOT NULL REFERENCES plex_playlists(id) ON DELETE CASCADE,
  list_item_id          INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  plex_rating_key       TEXT NOT NULL,
  plex_playlist_item_id TEXT,     -- needed for targeted removal
  synced_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plex_playlist_id_fk, list_item_id)
);
