# Bug Report: Permission Denied on Mirror Backfill (Unraid/Docker)

## Overview
Users running TuneFetch on Unraid are encountering `EACCES: permission denied` errors during the mirror backfill process. The error specifically occurs when the application attempts to create directories for mirrored music files.

### Error Message
```text
tunefetch  | [mirror] backfill: failed to copy /music/Music/Kids/Imagine Dragons/Evolve (2017)/Imagine Dragons - Evolve - 06 - I’ll Make It Up to You.flac: Error: EACCES: permission denied, mkdir '/music'
tunefetch  |   errno: -13,
tunefetch  |   code: 'EACCES',
tunefetch  |   syscall: 'mkdir',
tunefetch  |   path: '/music'
```

## Technical Analysis

### Root Cause
The failure occurs in the `copyFile` function within `src/lib/server/mirror.ts`. This function uses `fs.mkdir(dirname(destPath), { recursive: true })` to ensure the destination directory exists before copying.

On Unraid systems, music libraries are typically mounted as volumes (e.g., `/music`). These folders often have specific ownership (usually `99:100` for `nobody:users`). If the TuneFetch container is running as a different user (e.g., the default `1000:1000` defined in the `Dockerfile`), it lacks the necessary permissions to `stat` or `mkdir` within that mount point.

The error `mkdir '/music'` indicates that Node.js failed to verify or create the very first component of the path, likely because the process user cannot access the root-level mount point.

### Affected Code

#### [mirror.ts](file:///d:/GitHub/TuneFetch/src/lib/server/mirror.ts)
```typescript
// src/lib/server/mirror.ts:54
export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  // This line fails when destPath starts with a mount point the user can't access
  await fs.mkdir(dirname(destPath), { recursive: true });
  
  const tmp = destPath + '.tunefetch.tmp';
  try {
    await fs.copyFile(sourcePath, tmp);
    await fs.rename(tmp, destPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
```

#### [Dockerfile](file:///d:/GitHub/TuneFetch/Dockerfile)
The `Dockerfile` defines default UID/GID as 1000:
```dockerfile
# Dockerfile:52
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TUNEFETCH_DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000
```

#### [entrypoint.sh](file:///d:/GitHub/TuneFetch/docker/entrypoint.sh)
The entrypoint uses `su-exec` to drop privileges, but it does not currently handle `UMASK` settings which are often required on Unraid (e.g., `UMASK=000`).

## Recommendations for Senior Dev

1.  **UMASK Implementation**: Add `umask` support to `docker/entrypoint.sh`. If a `UMASK` environment variable is provided, it should be applied before the `exec` command to ensure created directories/files have the correct permissions (e.g., `777` if `UMASK=000`).
2.  **Permission Pre-flight Check**: In `mirror.ts`, consider adding a more descriptive error message if the `targetRoot` is not writable by the current process user.
3.  **Documentation Update**: Explicitly document that for Unraid users, `PUID` should be set to `99` and `PGID` to `100` to match standard Unraid share permissions.

## User Context
The user noted that another container with the following configuration works correctly:
- **PUID**: 99
- **PGID**: 100
- **UMASK**: 000
