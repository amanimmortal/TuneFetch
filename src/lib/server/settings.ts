import { getDb } from './db';
import { decrypt, isEncrypted } from './crypto';

/**
 * Known settings keys. Values are stored as strings in SQLite;
 * helpers below coerce where appropriate.
 */
export const SETTING_KEYS = {
  LIDARR_URL: 'lidarr_url',
  LIDARR_API_KEY: 'lidarr_api_key',
  ADMIN_CONTACT_EMAIL: 'admin_contact_email',
  ORPHAN_SCAN_TIME: 'orphan_scan_time', // HH:MM, 24-hour. Default 03:00.
  PLEX_URL: 'plex_url',
  PLEX_ADMIN_TOKEN: 'plex_admin_token',
  MUSIC_ASSISTANT_URL: 'music_assistant_url',
  MUSIC_ASSISTANT_TOKEN: 'music_assistant_token'
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

/**
 * Return the Plex base URL and admin token.
 *
 * Throws a plain Error if either value is missing.
 */
export function getPlexConfig(): { baseUrl: string; adminToken: string } {
  const baseUrl = getSetting(SETTING_KEYS.PLEX_URL);
  const adminToken = getSetting(SETTING_KEYS.PLEX_ADMIN_TOKEN);
  if (!baseUrl || !adminToken) {
    throw new Error(
      'Plex URL and admin token must be configured in Settings before using this feature.'
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), adminToken };
}

/**
 * Return the Music Assistant base URL and bearer token.
 *
 * Throws a plain Error if either value is missing — auth is mandatory in MA
 * as of schema v28, so a configured URL without a token is a misconfiguration.
 *
 * The token is stored encrypted at rest (matching the Plex token pattern);
 * decrypt transparently if the prefix is present, but accept plaintext as a
 * fallback so manually-seeded values still work.
 */
export function getMusicAssistantConfig(): { baseUrl: string; token: string } {
  const baseUrl = getSetting(SETTING_KEYS.MUSIC_ASSISTANT_URL);
  const stored = getSetting(SETTING_KEYS.MUSIC_ASSISTANT_TOKEN);
  if (!baseUrl || !stored) {
    throw new Error(
      'Music Assistant URL and bearer token must be configured in Settings before using this feature.'
    );
  }
  const token = isEncrypted(stored) ? decrypt(stored) : stored;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/**
 * True when MA is configured. Used by the sync engine to skip silently when
 * the user hasn't enabled the integration, so MA stays opt-in.
 */
export function isMusicAssistantConfigured(): boolean {
  return Boolean(
    getSetting(SETTING_KEYS.MUSIC_ASSISTANT_URL) &&
      getSetting(SETTING_KEYS.MUSIC_ASSISTANT_TOKEN)
  );
}
