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
                   CHECK(sync_status IN ('pending','synced','failed','mirror_pending','mirror_active','mirror_broken','awaiting_release')),
  sync_error       TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_list_items_mbid ON list_items(mbid);
CREATE INDEX IF NOT EXISTS idx_list_items_artist_mbid ON list_items(artist_mbid);

-- File copies created by TuneFetch for secondary-list items (OQ-7 resolved).
--
-- lidarr_track_file_id / lidarr_track_id are the stable handles we use to
-- re-resolve a current source path against Lidarr when the cached source_path
-- becomes invalid (file moved, renamed, upgraded). Both are nullable for legacy
-- rows created before the columns existed; the verifier backfills them.
--
-- last_verified_at records the most recent successful confirmation that the
-- cached source_path matches what Lidarr reports. last_error stores the most
-- recent copy/refresh failure so the UI can surface a diagnostic without
-- forcing the user to dig through logs.
CREATE TABLE IF NOT EXISTS mirror_files (
  id                   INTEGER PRIMARY KEY,
  list_item_id         INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  source_path          TEXT NOT NULL,
  mirror_path          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','active','stale')),
  lidarr_track_file_id INTEGER,
  lidarr_track_id      INTEGER,
  last_verified_at     DATETIME,
  last_error           TEXT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mirror_files_list_item ON mirror_files(list_item_id);
CREATE INDEX IF NOT EXISTS idx_mirror_files_source ON mirror_files(source_path);
-- idx_mirror_files_track_file is created in db.ts, after the ALTER TABLE
-- that adds lidarr_track_file_id. Creating it here would fail on existing
-- databases where CREATE TABLE IF NOT EXISTS is a no-op and the column
-- doesn't exist yet at the point this file runs.

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

-- Permanently ignored paths for the orphan scan.
-- Files listed here are never reported as orphans, even after a fresh scan.
-- Populated by the user via "Dismiss" actions on the Mirror Health page.
CREATE TABLE IF NOT EXISTS orphan_ignore_list (
  file_path   TEXT PRIMARY KEY,
  ignored_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Maps Lidarr root folder paths to Plex users.
-- A single root folder can be shared by multiple Plex users — e.g. a "kids"
-- music tree consumed by both Finn and Theo, each of whom needs their own
-- per-user Plex playlists. Uniqueness is on (root_folder_path, plex_user_name)
-- so the same human cannot be added twice for one root, but multiple users
-- for the same root are allowed.
CREATE TABLE IF NOT EXISTS plex_user_mappings (
  id                    INTEGER PRIMARY KEY,
  root_folder_path      TEXT NOT NULL,
  plex_user_name        TEXT NOT NULL,
  plex_user_token       TEXT NOT NULL,
  -- Numeric plex.tv home user ID — used to get a fresh switch token at sync time.
  plex_user_id          INTEGER,
  -- The Plex music library section ID for this user.
  -- Each user/family group may have a separate music library in Plex.
  library_section_id    TEXT NOT NULL DEFAULT '',
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_folder_path, plex_user_name)
);

-- Links a TuneFetch list to a Plex playlist for a specific user.
-- A single list can have multiple plex_playlists rows (different users),
-- and a single user can have multiple playlists from different lists.
CREATE TABLE IF NOT EXISTS plex_playlists (
  id                  INTEGER PRIMARY KEY,
  list_id             INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  plex_user_token     TEXT NOT NULL,
  plex_user_name      TEXT NOT NULL,
  plex_playlist_id    TEXT,            -- null until first sync creates it in Plex
  playlist_title      TEXT NOT NULL,
  last_synced_at      DATETIME,
  -- MA's playlist item_id once we've created/matched it. Null until first MA
  -- sync. Persisted so subsequent syncs don't have to look up by name.
  ma_playlist_item_id TEXT,
  -- MA's provider domain/instance for the playlist (typically 'library' for
  -- MA-native playlists). Stored alongside ma_playlist_item_id so cached-id
  -- lookups don't have to assume a provider.
  ma_playlist_provider TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plex_playlists_list ON plex_playlists(list_id);

-- Caches the resolved canonical release-group for each MusicBrainz recording.
-- No TTL: MB metadata for original albums rarely changes.
CREATE TABLE IF NOT EXISTS canonical_album_cache (
  recording_mbid      TEXT PRIMARY KEY,
  release_group_mbid  TEXT NOT NULL,
  release_group_title TEXT NOT NULL,
  year                TEXT,
  tier                INTEGER NOT NULL,
  cached_at           INTEGER NOT NULL  -- unix seconds
);

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
