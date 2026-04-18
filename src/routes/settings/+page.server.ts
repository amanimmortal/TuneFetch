import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { SETTING_KEYS, getAllSettings, setSetting } from '$lib/server/settings';
import { systemStatus, LidarrError } from '$lib/server/lidarr';

// ── Shared result shape ───────────────────────────────────────────────────────

type ConnectionStatus = 'ok' | 'error' | 'unconfigured';

interface ConnectionResult {
	connectionStatus: ConnectionStatus;
	connectionMessage: string;
}

async function testLidarrConnection(): Promise<ConnectionResult> {
	try {
		const status = await systemStatus();
		return {
			connectionStatus: 'ok',
			connectionMessage: `Connected — Lidarr ${status.version}`
		};
	} catch (err: unknown) {
		if (err instanceof LidarrError && err.message.includes('not configured')) {
			return {
				connectionStatus: 'unconfigured',
				connectionMessage: err.message
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			connectionStatus: 'error',
			connectionMessage: message
		};
	}
}

// ── Load ──────────────────────────────────────────────────────────────────────

export const load: PageServerLoad = async () => {
	const settings = getAllSettings();
	return {
		settings: {
			lidarrUrl: settings[SETTING_KEYS.LIDARR_URL] ?? '',
			lidarrApiKey: settings[SETTING_KEYS.LIDARR_API_KEY] ?? '',
			adminContactEmail: settings[SETTING_KEYS.ADMIN_CONTACT_EMAIL] ?? '',
			orphanScanTime: settings[SETTING_KEYS.ORPHAN_SCAN_TIME] ?? '03:00'
		}
	};
};

// ── Actions ───────────────────────────────────────────────────────────────────

export const actions: Actions = {
	/**
	 * Save all settings, then test the Lidarr connection.
	 * Returns the updated values and a connection status so the UI can
	 * show feedback without a full page reload (via use:enhance).
	 */
	save: async ({ request }) => {
		const data = await request.formData();

		const lidarrUrl = ((data.get('lidarr_url') as string | null) ?? '').trim();
		const lidarrApiKey = ((data.get('lidarr_api_key') as string | null) ?? '').trim();
		const adminContactEmail = ((data.get('admin_contact_email') as string | null) ?? '').trim();
		const orphanScanTime = ((data.get('orphan_scan_time') as string | null) ?? '03:00').trim();

		// Validate orphan scan time format
		if (!/^\d{2}:\d{2}$/.test(orphanScanTime)) {
			return fail(400, {
				error: 'Orphan scan time must be in HH:MM format.',
				connectionStatus: null as ConnectionStatus | null,
				connectionMessage: null as string | null
			});
		}

		setSetting(SETTING_KEYS.LIDARR_URL, lidarrUrl);
		setSetting(SETTING_KEYS.LIDARR_API_KEY, lidarrApiKey);
		setSetting(SETTING_KEYS.ADMIN_CONTACT_EMAIL, adminContactEmail);
		setSetting(SETTING_KEYS.ORPHAN_SCAN_TIME, orphanScanTime);

		// Test connection using the values just saved
		const connection =
			lidarrUrl && lidarrApiKey
				? await testLidarrConnection()
				: {
						connectionStatus: 'unconfigured' as const,
						connectionMessage: 'Lidarr URL and API key are required to test the connection.'
					};

		return { saved: true, ...connection };
	},

	/**
	 * Test the currently saved Lidarr connection without modifying settings.
	 * The "Test" button submits to this action via formaction="?/testConnection".
	 */
	testConnection: async () => {
		const connection = await testLidarrConnection();
		return { saved: false, ...connection };
	}
};
