/**
 * Plex API route: connection test, library sections, managed users,
 * user mappings CRUD, and triggering a manual sync.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	testConnection,
	getLibrarySections,
	getManagedUsers,
	PlexError
} from '$lib/server/plex';
import { syncListToPlexPlaylist } from '$lib/server/plex-sync';
import { getDb } from '$lib/server/db';
import { encrypt } from '$lib/server/crypto';

// GET /api/plex?action=...

export const GET: RequestHandler = async ({ url, fetch: svelteKitFetch }) => {
	const action = url.searchParams.get('action');

	try {
		switch (action) {
			case 'test': {
				const identity = await testConnection(svelteKitFetch);
				return json({
					ok: true,
					server: {
						name: identity.friendlyName ?? 'Plex Server',
						version: identity.version,
						machineId: identity.machineIdentifier
					}
				});
			}

			case 'sections': {
				const sections = await getLibrarySections(svelteKitFetch);
				return json({ ok: true, sections });
			}

			case 'users': {
				const { users, failures } = await getManagedUsers(svelteKitFetch);
				return json({ ok: true, users, failures });
			}

			case 'mappings': {
				const db = getDb();
				const mappings = db
					.prepare('SELECT * FROM plex_user_mappings ORDER BY root_folder_path')
					.all();
				return json({ ok: true, mappings });
			}

			case 'playlists': {
				const listId = url.searchParams.get('list_id');
				const db = getDb();
				let rows;
				if (listId) {
					rows = db
						.prepare(
							'SELECT * FROM plex_playlists WHERE list_id = ? ORDER BY created_at ASC'
						)
						.all(Number(listId));
				} else {
					rows = db.prepare('SELECT * FROM plex_playlists ORDER BY created_at ASC').all();
				}
				return json({ ok: true, playlists: rows });
			}

			default:
				throw error(400, `Unknown action: ${action}`);
		}
	} catch (err: unknown) {
		if (err instanceof PlexError) {
			return json(
				{ ok: false, error: err.message },
				{ status: err.status ?? 500 }
			);
		}
		throw err;
	}
};

// POST /api/plex

export const POST: RequestHandler = async ({ request, fetch: svelteKitFetch }) => {
	const body = await request.json();
	const action = body.action as string;

	const db = getDb();

	try {
		switch (action) {
			// Save user mapping
			case 'save_mapping': {
				const { root_folder_path, plex_user_name, plex_user_token, library_section_id } = body;
				if (!root_folder_path || !plex_user_name || !plex_user_token) {
					throw error(400, 'root_folder_path, plex_user_name, and plex_user_token are required');
				}
				db.prepare(
					`INSERT INTO plex_user_mappings (root_folder_path, plex_user_name, plex_user_token, library_section_id)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(root_folder_path) DO UPDATE SET
					   plex_user_name = excluded.plex_user_name,
					   plex_user_token = excluded.plex_user_token,
					   library_section_id = excluded.library_section_id`
				).run(root_folder_path, plex_user_name, encrypt(plex_user_token), library_section_id ?? '');
				return json({ ok: true });
			}

			// Delete user mapping
			case 'delete_mapping': {
				const { id } = body;
				if (!id) throw error(400, 'id is required');
				db.prepare('DELETE FROM plex_user_mappings WHERE id = ?').run(id);
				return json({ ok: true });
			}

			// Create a plex_playlists row (link a list to a Plex playlist).
			// Accepts mapping_id -- token is resolved server-side from plex_user_mappings
			// to avoid sending the encrypted token through the client and double-encrypting it.
			case 'create_playlist_link': {
				const { list_id, mapping_id, playlist_title } = body;
				if (!list_id || !mapping_id || !playlist_title) {
					throw error(400, 'list_id, mapping_id, and playlist_title are required');
				}
				const mapping = db
					.prepare('SELECT plex_user_token, plex_user_name FROM plex_user_mappings WHERE id = ?')
					.get(mapping_id) as { plex_user_token: string; plex_user_name: string } | undefined;
				if (!mapping) throw error(404, 'Plex user mapping not found');
				// mapping.plex_user_token is already encrypted at rest -- store verbatim.
				const result = db
					.prepare(
						`INSERT INTO plex_playlists (list_id, plex_user_token, plex_user_name, playlist_title)
						 VALUES (?, ?, ?, ?)`
					)
					.run(list_id, mapping.plex_user_token, mapping.plex_user_name, playlist_title);
				return json({ ok: true, id: result.lastInsertRowid });
			}

			// Delete a plex_playlists row
			case 'delete_playlist_link': {
				const { id: deleteId } = body;
				if (!deleteId) throw error(400, 'id is required');
				db.prepare('DELETE FROM plex_playlists WHERE id = ?').run(deleteId);
				return json({ ok: true });
			}

			// Trigger manual sync
			case 'sync': {
				const { playlist_id } = body;
				if (!playlist_id) throw error(400, 'playlist_id is required');
				const syncResult = await syncListToPlexPlaylist(Number(playlist_id));
				return json({ ok: true, result: syncResult });
			}

			default:
				throw error(400, `Unknown action: ${action}`);
		}
	} catch (err: unknown) {
		if (err instanceof PlexError) {
			return json(
				{ ok: false, error: err.message },
				{ status: err.status ?? 500 }
			);
		}
		throw err;
	}
};
