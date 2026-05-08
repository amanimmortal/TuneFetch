import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getDb } from "$lib/server/db";
import {
	rootFolders,
	LidarrError,
	listArtists,
	updateArtist,
	getQualityProfiles,
	getMetadataProfiles
} from "$lib/server/lidarr";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListRow {
	id: number;
	name: string;
	root_folder_path: string;
	quality_profile_id: number | null;
	metadata_profile_id: number | null;
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
			`SELECT l.id, l.name, l.root_folder_path, l.quality_profile_id, l.metadata_profile_id,
              COUNT(li.id) as item_count
       FROM lists l
       LEFT JOIN list_items li ON li.list_id = l.id
       GROUP BY l.id
       ORDER BY l.name ASC`
		)
		.all() as ListRow[];

	let folders: Array<{ id: number; path: string; freeSpace: number }> = [];
	let qualityProfiles: Array<{ id: number; name: string }> = [];
	let metadataProfiles: Array<{ id: number; name: string }> = [];
	let lidarrError: string | null = null;
	try {
		[folders, qualityProfiles, metadataProfiles] = await Promise.all([
			rootFolders(),
			getQualityProfiles(),
			getMetadataProfiles()
		]);
	} catch (err) {
		lidarrError = err instanceof LidarrError ? err.message : String(err);
	}

	return { lists, folders, qualityProfiles, metadataProfiles, lidarrError };
};

// ── Actions ───────────────────────────────────────────────────────────────────

export const actions: Actions = {
	/** Create a new list. */
	create: async ({ request }) => {
		const data = await request.formData();
		const name = ((data.get("name") as string) ?? "").trim();
		const rootFolderPath = ((data.get("root_folder_path") as string) ?? "").trim();
		const qualityProfileId = Number(data.get("quality_profile_id")) || null;
		const metadataProfileId = Number(data.get("metadata_profile_id")) || null;

		if (!name) return fail(400, { createError: "Name is required." });
		if (!rootFolderPath) return fail(400, { createError: "Root folder is required." });
		if (!qualityProfileId) return fail(400, { createError: "Quality profile is required." });
		if (!metadataProfileId) return fail(400, { createError: "Metadata profile is required." });

		try {
			getDb()
				.prepare(
					"INSERT INTO lists (name, root_folder_path, quality_profile_id, metadata_profile_id) VALUES (?, ?, ?, ?)"
				)
				.run(name, rootFolderPath, qualityProfileId, metadataProfileId);
		} catch {
			return fail(500, { createError: "Failed to create list." });
		}
		return { created: true };
	},

	/** Update quality/metadata profile settings for an existing list. */
	updateSettings: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get("id"));
		const qualityProfileId = Number(data.get("quality_profile_id")) || null;
		const metadataProfileId = Number(data.get("metadata_profile_id")) || null;

		if (!qualityProfileId) return fail(400, { settingsError: "Quality profile is required.", settingsId: id });
		if (!metadataProfileId) return fail(400, { settingsError: "Metadata profile is required.", settingsId: id });

		getDb()
			.prepare(
				"UPDATE lists SET quality_profile_id = ?, metadata_profile_id = ? WHERE id = ?"
			)
			.run(qualityProfileId, metadataProfileId, id);
		return { settingsSaved: true };
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
	 * - Unlinks all mirror files from disk to prevent orphaning.
	 * - Deletes the list (cascade removes list_items + mirror_files).
	 */
	delete: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get("id"));

		const db = getDb();
		const fs = await import('fs/promises');

		// Find all mirrored files for this list
		const mirrorFiles = db
			.prepare(
				`SELECT mf.mirror_path
				 FROM mirror_files mf
				 JOIN list_items li ON li.id = mf.list_item_id
				 WHERE li.list_id = ? AND mf.mirror_path IS NOT NULL`
			)
			.all(id) as Array<{ mirror_path: string }>;

		// Delete files from disk to prevent orphans
		for (const file of mirrorFiles) {
			try {
				await fs.unlink(file.mirror_path);
			} catch (err) {
				// Ignore ENOENT (file already gone), log others
				if (err instanceof Error && 'code' in err && (err as any).code !== 'ENOENT') {
					console.error(`[delete] Failed to unlink ${file.mirror_path}:`, err);
				}
			}
		}

		// Delete the list -- cascades to list_items and mirror_files
		db.prepare("DELETE FROM lists WHERE id = ?").run(id);
		return { deleted: true };
	}
};
