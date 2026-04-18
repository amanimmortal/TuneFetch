import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getDb } from "$lib/server/db";
import { rootFolders, LidarrError, listArtists, updateArtist } from "$lib/server/lidarr";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListRow {
	id: number;
	name: string;
	root_folder_path: string;
	item_count: number;
}

interface OwnedArtistRow {
	artist_mbid: string;
	lidarr_artist_id: number;
	root_folder_path: string;
	display_name: string;
}

interface AltListRow {
	list_id: number;
	list_name: string;
	root_folder_path: string;
}

// ── Load ──────────────────────────────────────────────────────────────────────

export const load: PageServerLoad = async () => {
	const db = getDb();

	const lists = db
		.prepare(
			`SELECT l.id, l.name, l.root_folder_path, COUNT(li.id) as item_count
       FROM lists l
       LEFT JOIN list_items li ON li.list_id = l.id
       GROUP BY l.id
       ORDER BY l.name ASC`
		)
		.all() as ListRow[];

	let folders: Array<{ id: number; path: string; freeSpace: number }> = [];
	let lidarrError: string | null = null;
	try {
		folders = await rootFolders();
	} catch (err) {
		lidarrError = err instanceof LidarrError ? err.message : String(err);
	}

	return { lists, folders, lidarrError };
};

// ── Actions ───────────────────────────────────────────────────────────────────

export const actions: Actions = {
	/** Create a new list. */
	create: async ({ request }) => {
		const data = await request.formData();
		const name = ((data.get("name") as string) ?? "").trim();
		const rootFolderPath = ((data.get("root_folder_path") as string) ?? "").trim();

		if (!name) return fail(400, { createError: "Name is required." });
		if (!rootFolderPath) return fail(400, { createError: "Root folder is required." });

		try {
			getDb()
				.prepare("INSERT INTO lists (name, root_folder_path) VALUES (?, ?)")
				.run(name, rootFolderPath);
		} catch {
			return fail(500, { createError: "Failed to create list." });
		}
		return { created: true };
	},

	/** Rename an existing list. */
	rename: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get("id"));
		const name = ((data.get("name") as string) ?? "").trim();

		if (!name) return fail(400, { renameError: "Name is required.", renameId: id });

		getDb().prepare("UPDATE lists SET name = ? WHERE id = ?").run(name, id);
		return { renamed: true };
	},

	/**
	 * Delete a list.
	 *
	 * First call (confirmed = false / missing):
	 *   - Checks artist_ownership for this list.
	 *   - If any owned artists exist, returns a warning with transferable and blocked groups.
	 *   - If no owned artists, deletes immediately.
	 *
	 * Second call (confirmed = true):
	 *   - Performs ownership transfers for all transferable artists (Lidarr + DB).
	 *   - Deletes the list (cascade removes list_items + mirror_files).
	 *   - Still blocked if any artists have no transfer target.
	 */
	delete: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get("id"));
		const confirmed = data.get("confirmed") === "true";

		const db = getDb();

		// Find all artists this list owns in Lidarr
		const ownedArtists = db
			.prepare(
				`SELECT ao.artist_mbid, ao.lidarr_artist_id, ao.root_folder_path,
              COALESCE(
                (SELECT li2.artist_name FROM list_items li2
                 WHERE li2.lidarr_artist_id = ao.lidarr_artist_id
                   AND li2.list_id = ao.owner_list_id LIMIT 1),
                ao.artist_mbid
              ) as display_name
         FROM artist_ownership ao
         WHERE ao.owner_list_id = ?`
			)
			.all(id) as OwnedArtistRow[];

		if (ownedArtists.length > 0) {
			// Categorise each owned artist as transferable or blocked
			const transferable: Array<
				OwnedArtistRow & {
					newOwnerListId: number;
					newOwnerName: string;
					newOwnerRootFolder: string;
				}
			> = [];
			const blocked: OwnedArtistRow[] = [];

			for (const artist of ownedArtists) {
				const alt = db
					.prepare(
						`SELECT li.list_id, l.name as list_name, l.root_folder_path
               FROM list_items li
               JOIN lists l ON l.id = li.list_id
               WHERE li.lidarr_artist_id = ? AND li.list_id != ?
               LIMIT 1`
					)
					.get(artist.lidarr_artist_id, id) as AltListRow | undefined;

				if (alt) {
					transferable.push({
						...artist,
						newOwnerListId: alt.list_id,
						newOwnerName: alt.list_name,
						newOwnerRootFolder: alt.root_folder_path
					});
				} else {
					blocked.push(artist);
				}
			}

			// Surface warning if: not yet confirmed, or there are blocked artists
			if (!confirmed || blocked.length > 0) {
				return {
					deleteWarning: true as const,
					deleteId: id,
					transferable,
					blocked
				};
			}

			// confirmed && no blocked — perform ownership transfers
			for (const artist of transferable) {
				// Best-effort: update Lidarr rootFolderPath (Lidarr will physically move files)
				try {
					const lidarrArtists = await listArtists();
					const lidarrArtist = lidarrArtists.find((a) => a.id === artist.lidarr_artist_id);
					if (lidarrArtist) {
						await updateArtist({ ...lidarrArtist, rootFolderPath: artist.newOwnerRootFolder });
					}
				} catch {
					console.error(
						`[delete] Failed to update Lidarr rootFolderPath for artist ${artist.artist_mbid} — continuing with DB transfer`
					);
				}

				// Update ownership record in DB
				db.prepare(
					`UPDATE artist_ownership
           SET owner_list_id = ?, root_folder_path = ?
           WHERE artist_mbid = ?`
				).run(artist.newOwnerListId, artist.newOwnerRootFolder, artist.artist_mbid);
			}
		}

		// Delete the list — cascades to list_items and mirror_files
		db.prepare("DELETE FROM lists WHERE id = ?").run(id);
		return { deleted: true };
	}
};
