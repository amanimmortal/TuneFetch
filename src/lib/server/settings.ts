import { getDb } from './db';

/**
 * Known settings keys. Values are stored as strings in SQLite;
 * helpers below coerce where appropriate.
 */
export const SETTING_KEYS = {
  LIDARR_URL: 'lidarr_url',
  LIDARR_API_KEY: 'lidarr_api_key',
  ADMIN_CONTACT_EMAIL: 'admin_contact_email',
  ORPHAN_SCAN_TIME: 'orphan_scan_time' // HH:MM, 24-hour. Default 03:00.
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Retrieve a setting value, or null if not set. */
export function getSetting(key: SettingKey): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Upsert a setting value. */
export function setSetting(key: SettingKey, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

/** Return all settings as a plain object. */
export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Return the Lidarr base URL and API key.
 *
 * Throws a plain Error (not LidarrError — settings has no dep on lidarr)
 * if either value is missing, so callers that require a configured Lidarr
 * can fail fast with a clear message before attempting any network call.
 */
export function getLidarrConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = getSetting(SETTING_KEYS.LIDARR_URL);
  const apiKey = getSetting(SETTING_KEYS.LIDARR_API_KEY);
  if (!baseUrl || !apiKey) {
    throw new Error(
      'Lidarr URL and API key must be configured in Settings before using this feature.'
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}
