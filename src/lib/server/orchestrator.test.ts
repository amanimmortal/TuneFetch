/**
 * Orchestrator unit tests — Scenarios A, B, C.
 *
 * Strategy:
 *   - Real in-memory SQLite for each test (schema applied fresh per describe block).
 *   - vi.mock() for Lidarr API functions and the mirror startBackfill.
 *   - The DB mock returns the same in-memory instance on every getDb() call
 *     within a test, matching the production singleton pattern.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import schemaSql from './schema.sql?raw';

// ── Module mocks (hoisted to top of file by Vitest) ───────────────────────────

vi.mock('./lidarr', () => ({
  LidarrError: class LidarrError extends Error {
    name = 'LidarrError';
    status?: number;
    body?: string;
    constructor(msg: string, status?: number, body?: string) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  },
  getArtistByMbid: vi.fn(),
  addArtist:       vi.fn(),
  getAlbum:        vi.fn(),
  getAlbums:       vi.fn(),
  updateAlbum:     vi.fn(),
  getTracks:       vi.fn(),
  runCommand:      vi.fn(),
}));

vi.mock('./mirror', () => ({
  startBackfill:      vi.fn().mockResolvedValue(undefined),
  flushPendingCopies: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./db', () => ({ getDb: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { getDb } from './db';
import {
  getArtistByMbid,
  addArtist,
  getAlbum,
  getAlbums,
  updateAlbum,
  getTracks,
  runCommand,
} from './lidarr';
import { startBackfill } from './mirror';
import { orchestrate } from './orchestrator';

const mockGetDb       = vi.mocked(getDb);
const mockGetArtist   = vi.mocked(getArtistByMbid);
const mockAddArtist   = vi.mocked(addArtist);
const mockGetAlbum    = vi.mocked(getAlbum);
const mockGetAlbums   = vi.mocked(getAlbums);
const mockUpdateAlbum = vi.mocked(updateAlbum);
const mockGetTracks   = vi.mocked(getTracks);
const mockRunCommand  = vi.mocked(runCommand);
const mockBackfill    = vi.mocked(startBackfill);

/** Create a fresh in-memory SQLite DB with the full schema applied. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);
  return db;
}

/** Minimal Lidarr artist shape returned from addArtist / getArtistByMbid. */
function lidarrArtist(overrides: Partial<{
  id: number; foreignArtistId: string; artistName: string; rootFolderPath: string;
}> = {}) {
  return {
    id: 99,
    foreignArtistId: 'artist-mbid-1',
    artistName: 'Test Artist',
    rootFolderPath: '/root/a',
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 1,
    ...overrides,
  };
}

/** Seed common rows into a test DB and return their IDs. */
function seedDb(db: Database.Database, opts: {
  listRoot?: string;
  itemType?: 'artist' | 'album' | 'track';
  itemMbid?: string;
  artistMbid?: string;
}) {
  const {
    listRoot = '/root/a',
    itemType = 'artist',
    itemMbid = 'item-mbid-1',
    artistMbid = 'artist-mbid-1',
  } = opts;

  const listId = (db.prepare(
    `INSERT INTO lists (name, root_folder_path) VALUES ('TestList', ?) RETURNING id`
  ).get(listRoot) as { id: number }).id;

  const itemId = (db.prepare(
    `INSERT INTO list_items (list_id, mbid, type, title, artist_name, artist_mbid)
     VALUES (?, ?, ?, 'Test Item', 'Test Artist', ?) RETURNING id`
  ).get(listId, itemMbid, itemType, artistMbid) as { id: number }).id;

  return { listId, itemId };
}

function getSyncStatus(db: Database.Database, itemId: number) {
  return (db.prepare('SELECT sync_status, sync_error FROM list_items WHERE id = ?').get(itemId) as
    { sync_status: string; sync_error: string | null });
}

function getOwnership(db: Database.Database, artistMbid: string) {
  return db.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?').get(artistMbid) as
    { lidarr_artist_id: number; owner_list_id: number; root_folder_path: string } | undefined;
}

// ── Scenario A — Artist add ───────────────────────────────────────────────────

describe('Scenario A — artist type', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    mockGetDb.mockReturnValue(db as any);
    mockRunCommand.mockResolvedValue({ id: 1, name: 'ArtistSearch', status: 'queued' });
  });

  it('adds a new artist to Lidarr and marks synced', async () => {
    const { itemId } = seedDb(db, { itemType: 'artist', itemMbid: 'artist-mbid-1' });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockResolvedValue(lidarrArtist({ id: 42 }));

    await orchestrate(itemId);

    expect(mockAddArtist).toHaveBeenCalledWith(expect.objectContaining({
      foreignArtistId: 'artist-mbid-1',
      addOptions: { monitor: 'all', searchForMissingAlbums: true },
    }));
    expect(mockRunCommand).toHaveBeenCalledWith('ArtistSearch', { artistId: 42 });

    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');

    const ownership = getOwnership(db, 'artist-mbid-1');
    expect(ownership?.lidarr_artist_id).toBe(42);
  });

  it('marks synced when artist already exists in same root folder', async () => {
    const { itemId } = seedDb(db, { itemType: 'artist', itemMbid: 'artist-mbid-1', listRoot: '/root/a' });
    // Pre-populate ownership so the existing-artist path writes DO NOTHING on conflict
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES ('artist-mbid-1', 55, 1, '/root/a')`
    ).run();
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 55, rootFolderPath: '/root/a' }));

    await orchestrate(itemId);

    expect(mockAddArtist).not.toHaveBeenCalled();
    // No ArtistSearch for existing artists
    expect(mockRunCommand).not.toHaveBeenCalled();
    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');
  });

  it('starts mirror backfill when artist is in a different root folder', async () => {
    // List is /root/b but artist is owned under /root/a
    const { itemId, listId } = seedDb(db, { itemType: 'artist', itemMbid: 'artist-mbid-1', listRoot: '/root/b' });
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES ('artist-mbid-1', 55, ?, '/root/a')`
    ).run(listId);
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 55, rootFolderPath: '/root/a' }));

    await orchestrate(itemId);

    expect(mockAddArtist).not.toHaveBeenCalled();
    expect(mockBackfill).toHaveBeenCalledWith(55, itemId, '/root/a', '/root/b');
    // Status is set to mirror_pending before backfill runs
    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('mirror_pending');
  });

  it('marks failed when Lidarr addArtist throws', async () => {
    const { itemId } = seedDb(db, { itemType: 'artist', itemMbid: 'artist-mbid-1' });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockRejectedValue(new Error('Lidarr 500'));

    await orchestrate(itemId);

    const { sync_status, sync_error } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('failed');
    expect(sync_error).toContain('Lidarr 500');
  });
});

// ── Scenario B — Track add ────────────────────────────────────────────────────

describe('Scenario B — track type', () => {
  let db: Database.Database;
  const TRACK_MBID   = 'track-mbid-1';
  const ARTIST_MBID  = 'artist-mbid-1';

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    mockGetDb.mockReturnValue(db as any);
    mockRunCommand.mockResolvedValue({ id: 1, name: 'AlbumSearch', status: 'queued' });
    mockGetAlbum.mockResolvedValue({ id: 5, monitored: false } as any);
    mockUpdateAlbum.mockResolvedValue({} as any);
  });

  const mockTrackList = [
    { id: 10, foreignTrackId: TRACK_MBID, artistId: 42, albumId: 5, title: 'Test Track', monitored: false },
  ];

  it('adds artist (monitor=none) then monitors the track when artist not in Lidarr', async () => {
    const { itemId } = seedDb(db, { itemType: 'track', itemMbid: TRACK_MBID, artistMbid: ARTIST_MBID });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockResolvedValue(lidarrArtist({ id: 42 }));
    mockGetTracks.mockResolvedValue(mockTrackList);

    await orchestrate(itemId);

    expect(mockAddArtist).toHaveBeenCalledWith(expect.objectContaining({
      foreignArtistId: ARTIST_MBID,
      addOptions: { monitor: 'none', searchForMissingAlbums: false },
    }));
    expect(mockGetAlbum).toHaveBeenCalledWith(5);
    expect(mockUpdateAlbum).toHaveBeenCalledWith(expect.objectContaining({
      id: 5,
      monitored: true,
    }));
    expect(mockRunCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [5] });

    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');
  });

  it('monitors the track when artist already exists in same root folder', async () => {
    const { itemId, listId } = seedDb(db, { itemType: 'track', itemMbid: TRACK_MBID, artistMbid: ARTIST_MBID, listRoot: '/root/a' });
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES (?, 42, ?, '/root/a')`
    ).run(ARTIST_MBID, listId);
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 42, rootFolderPath: '/root/a' }));
    mockGetTracks.mockResolvedValue(mockTrackList);

    await orchestrate(itemId);

    expect(mockAddArtist).not.toHaveBeenCalled();
    expect(mockGetAlbum).toHaveBeenCalledWith(5);
    expect(mockUpdateAlbum).toHaveBeenCalledWith(expect.objectContaining({ id: 5, monitored: true }));
    expect(mockRunCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [5] });

    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');
  });

  it('starts backfill when artist is in a different root folder', async () => {
    const { itemId, listId } = seedDb(db, { itemType: 'track', itemMbid: TRACK_MBID, artistMbid: ARTIST_MBID, listRoot: '/root/b' });
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES (?, 42, ?, '/root/a')`
    ).run(ARTIST_MBID, listId);
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 42, rootFolderPath: '/root/a' }));

    await orchestrate(itemId);

    expect(mockBackfill).toHaveBeenCalledWith(42, itemId, '/root/a', '/root/b');
    expect(mockUpdateAlbum).not.toHaveBeenCalled();
    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('mirror_pending');
  });

  it('marks failed when artist_mbid is missing and no prior artist in DB', async () => {
    // Insert item without artist_mbid
    const listId = (db.prepare(
      `INSERT INTO lists (name, root_folder_path) VALUES ('L', '/root/a') RETURNING id`
    ).get() as { id: number }).id;
    const itemId = (db.prepare(
      `INSERT INTO list_items (list_id, mbid, type, title, artist_name, artist_mbid)
       VALUES (?, ?, 'track', 'T', 'A', NULL) RETURNING id`
    ).get(listId, TRACK_MBID) as { id: number }).id;

    await orchestrate(itemId);

    const { sync_status, sync_error } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('failed');
    expect(sync_error).toContain('artist MusicBrainz ID was not captured');
  });

  it('marks failed when track MBID not found in Lidarr', async () => {
    const { itemId } = seedDb(db, { itemType: 'track', itemMbid: TRACK_MBID, artistMbid: ARTIST_MBID });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockResolvedValue(lidarrArtist({ id: 42 }));
    // Return tracks but none match our MBID
    mockGetTracks.mockResolvedValue([
      { id: 99, foreignTrackId: 'other-mbid', artistId: 42, albumId: 5, title: 'Other', monitored: false },
    ]);

    await orchestrate(itemId);

    const { sync_status, sync_error } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('failed');
    expect(sync_error).toContain('not found in Lidarr');
  });
});

// ── Scenario C — Album add ────────────────────────────────────────────────────

describe('Scenario C — album type', () => {
  let db: Database.Database;
  const ALBUM_MBID  = 'album-mbid-1';
  const ARTIST_MBID = 'artist-mbid-1';

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    mockGetDb.mockReturnValue(db as any);
    mockRunCommand.mockResolvedValue({ id: 1, name: 'AlbumSearch', status: 'queued' });
    mockUpdateAlbum.mockResolvedValue({} as any);
  });

  const mockAlbumList = [
    { id: 20, foreignAlbumId: ALBUM_MBID, artistId: 42, title: 'Test Album', monitored: false },
  ];

  it('adds artist (monitor=none) then monitors the album when artist not in Lidarr', async () => {
    const { itemId } = seedDb(db, { itemType: 'album', itemMbid: ALBUM_MBID, artistMbid: ARTIST_MBID });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockResolvedValue(lidarrArtist({ id: 42 }));
    mockGetAlbums.mockResolvedValue(mockAlbumList);

    await orchestrate(itemId);

    expect(mockAddArtist).toHaveBeenCalledWith(expect.objectContaining({
      foreignArtistId: ARTIST_MBID,
      addOptions: { monitor: 'none', searchForMissingAlbums: false },
    }));
    expect(mockUpdateAlbum).toHaveBeenCalledWith(expect.objectContaining({
      foreignAlbumId: ALBUM_MBID,
      monitored: true,
    }));
    expect(mockRunCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [20] });

    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');
  });

  it('monitors the album when artist already exists in same root folder', async () => {
    const { itemId, listId } = seedDb(db, { itemType: 'album', itemMbid: ALBUM_MBID, artistMbid: ARTIST_MBID, listRoot: '/root/a' });
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES (?, 42, ?, '/root/a')`
    ).run(ARTIST_MBID, listId);
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 42, rootFolderPath: '/root/a' }));
    mockGetAlbums.mockResolvedValue(mockAlbumList);

    await orchestrate(itemId);

    expect(mockAddArtist).not.toHaveBeenCalled();
    expect(mockUpdateAlbum).toHaveBeenCalledWith(expect.objectContaining({ monitored: true }));
    expect(mockRunCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [20] });

    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('synced');
  });

  it('starts backfill when artist is in a different root folder', async () => {
    const { itemId, listId } = seedDb(db, { itemType: 'album', itemMbid: ALBUM_MBID, artistMbid: ARTIST_MBID, listRoot: '/root/b' });
    db.prepare(
      `INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES (?, 42, ?, '/root/a')`
    ).run(ARTIST_MBID, listId);
    mockGetArtist.mockResolvedValue(lidarrArtist({ id: 42, rootFolderPath: '/root/a' }));

    await orchestrate(itemId);

    expect(mockBackfill).toHaveBeenCalledWith(42, itemId, '/root/a', '/root/b');
    expect(mockUpdateAlbum).not.toHaveBeenCalled();
    const { sync_status } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('mirror_pending');
  });

  it('marks failed when album MBID not found in Lidarr', async () => {
    const { itemId } = seedDb(db, { itemType: 'album', itemMbid: ALBUM_MBID, artistMbid: ARTIST_MBID });
    mockGetArtist.mockResolvedValue(null);
    mockAddArtist.mockResolvedValue(lidarrArtist({ id: 42 }));
    mockGetAlbums.mockResolvedValue([
      { id: 99, foreignAlbumId: 'other-album', artistId: 42, title: 'Other Album', monitored: false },
    ]);

    await orchestrate(itemId);

    const { sync_status, sync_error } = getSyncStatus(db, itemId);
    expect(sync_status).toBe('failed');
    expect(sync_error).toContain('not found in Lidarr');
  });
});
