import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const GET: RequestHandler = async ({ url }) => {
	// Default to /music in prod (Docker), fallback to home dir in local dev if not found
	const defaultPath = process.env.NODE_ENV === 'production' || process.env.TUNE_FETCH_DOCKER ? '/music' : os.homedir();
	const dirPath = url.searchParams.get('path') || defaultPath;

	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			return json({ error: 'Not a directory' }, { status: 400 });
		}

		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		
		const folders = entries
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(entry => ({
				name: entry.name,
				path: path.join(dirPath, entry.name).replace(/\\/g, '/')
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		// Find parent directory (unless we're at root)
		const parentPath = path.dirname(dirPath).replace(/\\/g, '/');
		const isRoot = parentPath === dirPath || parentPath === '.' || parentPath === '';

		return json({
			currentPath: dirPath.replace(/\\/g, '/'),
			parentPath: isRoot ? null : parentPath,
			folders
		});
	} catch (err) {
		console.error(`[browse] Directory access error for ${dirPath}:`, err);
		// If the default path fails, try to fallback to a very safe root on failure just so the UI doesn't completely break
		if (!url.searchParams.has('path') && dirPath === '/music') {
			try {
				const fallback = os.homedir();
				const entries = await fs.readdir(fallback, { withFileTypes: true });
				const folders = entries
					.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
					.map(entry => ({
						name: entry.name,
						path: path.join(fallback, entry.name).replace(/\\/g, '/')
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
				
				return json({
					currentPath: fallback.replace(/\\/g, '/'),
					parentPath: path.dirname(fallback).replace(/\\/g, '/'),
					folders
				});
			} catch (fallbackErr) {
				return json({ error: 'Directory not found or permission denied' }, { status: 404 });
			}
		}
		return json({ error: 'Directory not found or permission denied' }, { status: 404 });
	}
};
