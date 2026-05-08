# Handover: Single-Root Lidarr Architecture Migration

## Overview

This document summarizes the changes made to transition TuneFetch to a **Single-Root Architecture** for Lidarr, removing the complexity of managing multiple root folders in Lidarr and replacing it with a robust, scoped file-mirroring system.

## Key Changes

### 1. Architecture Shift (Single Primary Root)
- **Concept**: Lidarr now strictly manages one primary root folder. Secondary lists (e.g., for different users/devices) are treated as "mirror targets".
- **Database**: Dropped the `artist_ownership` table. Ownership is no longer tracked; all items are assumed to originate from the primary root.
- **Migrations**: Updated `db.ts` to drop `artist_ownership` if it exists.

### 2. Scoped Mirroring (`mirror.ts`)
- Overhauled mirroring to be **scope-aware** based on the list item type:
  - `artist`: Mirrors all files for the artist.
  - `album`: Mirrors only files matching the specific `lidarrAlbumId`.
  - `track`: Mirrors only the specific file matching the `trackFileId`.
- Added `pruneOutOfScopeMirrors()` to remove physical files and database records that are no longer in scope for any list.

### 3. Folder Picker UI
- **Backend**: Created `/api/browse` endpoint to allow browsing the server filesystem.
- **Frontend**: Created `FolderPicker.svelte` component to replace static dropdowns with a dynamic tree browser.
- **Security**: Restricted browsing to the configured base directory (e.g., `/music` in prod) to prevent directory traversal.

### 4. Scheduler & Maintenance
- Integrated `pruneOutOfScopeMirrors()` into the nightly orphan scan in `scheduler.ts`.
- Added a manual "Prune Out-of-Scope" action and button on the Mirror Health page.

### 5. Type Safety & Code Quality
- Added `trackFileId?: number` to the `LidarrTrack` interface in `lidarr.ts` to avoid repeated `unknown` casts.
- Cleaned up dynamic imports and type annotations in the Lidarr webhook handler to ensure successful builds.

### 6. Test Suite
- Completely refactored `orchestrator.test.ts` to remove reliance on `artist_ownership` and test the new primary-root fallback logic.

---

## Code Review Fixes Applied

During the final review, the following adjustments were made:
- **Scheduler**: Fixed handling of the return type of `pruneOutOfScopeMirrors()` (it returns an object with `pruned` and `errors` counts).
- **Mirroring**: Added logging for legacy rows with null `lidarr_track_file_id` during pruning so they aren't silently ignored.
- **Security**: Secured `/api/browse` using `path.resolve` and `startsWith` against the base directory.
- **Types**: Centralized `trackFileId` in the `LidarrTrack` interface.

## Verification Status

- **Unit Tests**: All tests in `orchestrator.test.ts` passed.
- **Build**: `npm run build` completed successfully with no type errors.

## Next Steps for the Next Developer

- **Integration Testing**: Verify the flow end-to-end with a real Lidarr instance if possible.
- **Monitor Pruning**: Keep an eye on logs for "legacy row" warnings during pruning to ensure no files are being leaked indefinitely.
