/**
 * Unit tests for plex.ts public API.
 *
 * Strategy:
 *   - vi.mock('./settings') so readConfig() never hits the database.
 *   - Inject a typed mock fetchFn into each function to control HTTP responses.
 *   - resetPlexCache() between tests to clear admin/machine memoization.
 *
 * What we cover here matches the post-rewrite token model (PLEX_REVIEW.md §10):
 *   - getManagedUsers() resolves per-user tokens via /api/servers/{machineId}/shared_servers.
 *   - The admin user is included in the result with the admin token.
 *   - Home users without library access are returned in `failures`, not `users`.
 *   - getUserAccessToken() returns the admin token for the owner and the
 *     shared_servers token for everyone else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getManagedUsers,
	getUserAccessToken,
	resetPlexCache,
	PlexError
} from './plex';

// ── Module mock: settings ─────────────────────────────────────────────────────

vi.mock('./settings', () => ({
	getSetting: vi.fn((key: string) => {
		if (key === 'plex_url') return 'http://plex.local:32400';
		if (key === 'plex_admin_token') return 'admin-token';
		return null;
	}),
	SETTING_KEYS: {
		PLEX_URL: 'plex_url',
		PLEX_ADMIN_TOKEN: 'plex_admin_token'
	}
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const MACHINE_ID = 'mid-abc123';
const ADMIN_ID = 1000;

function makeResponse(status: number, body: string, contentType?: string): Response {
	const headers: Record<string, string> = {};
	if (contentType) headers['Content-Type'] = contentType;
	return new Response(body, { status, headers });
}

function identityJson(): string {
	return JSON.stringify({
		MediaContainer: {
			machineIdentifier: MACHINE_ID,
			version: '1.40.0',
			friendlyName: 'TestServer'
		}
	});
}

function adminUserJson(): string {
	return JSON.stringify({ id: ADMIN_ID, title: 'Admin User', username: 'admin' });
}

function homeUsersXml(users: Array<{ id: number; title: string }>): string {
	const elements = users
		.map((u) => `<User id="${u.id}" title="${u.title}" />`)
		.join('\n');
	return `<MediaContainer>${elements}</MediaContainer>`;
}

function sharedServersXml(entries: Array<{ userID: number; accessToken: string }>): string {
	const elements = entries
		.map(
			(e) =>
				`<SharedServer userID="${e.userID}" accessToken="${e.accessToken}" />`
		)
		.join('\n');
	return `<MediaContainer>${elements}</MediaContainer>`;
}

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Build a fetch stub that responds to the four endpoints touched by
 * getManagedUsers / getUserAccessToken.
 */
interface MockResponse {
	status: number;
	body: string;
	contentType?: string;
}

function buildFetch(opts: {
	identity?: MockResponse;
	adminUser?: MockResponse;
	homeUsers?: MockResponse;
	sharedServers?: MockResponse;
}): FetchFn {
	return vi.fn(async (url) => {
		const u = String(url);
		if (u.startsWith('http://plex.local:32400/') && u.endsWith('/')) {
			const r = opts.identity ?? {
				status: 200,
				body: identityJson(),
				contentType: 'application/json'
			};
			return makeResponse(r.status, r.body, r.contentType);
		}
		if (u === 'http://plex.local:32400/') {
			const r = opts.identity ?? {
				status: 200,
				body: identityJson(),
				contentType: 'application/json'
			};
			return makeResponse(r.status, r.body, r.contentType);
		}
		if (u.includes('plex.tv/api/v2/user')) {
			const r = opts.adminUser ?? {
				status: 200,
				body: adminUserJson(),
				contentType: 'application/json'
			};
			return makeResponse(r.status, r.body, r.contentType);
		}
		if (u.includes('plex.tv/api/home/users')) {
			const r = opts.homeUsers ?? {
				status: 200,
				body: homeUsersXml([]),
				contentType: 'application/xml'
			};
			return makeResponse(r.status, r.body, r.contentType);
		}
		if (u.includes('/shared_servers')) {
			const r = opts.sharedServers ?? {
				status: 200,
				body: sharedServersXml([]),
				contentType: 'application/xml'
			};
			return makeResponse(r.status, r.body, r.contentType);
		}
		return makeResponse(500, `unexpected url: ${u}`);
	}) as FetchFn;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getManagedUsers()', () => {
	beforeEach(() => {
		resetPlexCache();
		vi.clearAllMocks();
	});

	it('happy path — admin + 2 home users with library access → 3 users, 0 failures', async () => {
		const fetchFn = buildFetch({
			homeUsers: {
				status: 200,
				body: homeUsersXml([
					{ id: 2001, title: 'Alice' },
					{ id: 2002, title: 'Bob' }
				])
			},
			sharedServers: {
				status: 200,
				body: sharedServersXml([
					{ userID: 2001, accessToken: 'token-alice' },
					{ userID: 2002, accessToken: 'token-bob' }
				])
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users).toHaveLength(3);
		expect(result.users[0]).toMatchObject({
			id: ADMIN_ID,
			title: 'Admin User',
			accessToken: 'admin-token',
			isAdmin: true
		});
		expect(result.users[1]).toMatchObject({
			id: 2001,
			title: 'Alice',
			accessToken: 'token-alice'
		});
		expect(result.users[2]).toMatchObject({
			id: 2002,
			title: 'Bob',
			accessToken: 'token-bob'
		});
		expect(result.failures).toHaveLength(0);
	});

	it('home user with no library shared → ends up in failures, not users', async () => {
		const fetchFn = buildFetch({
			homeUsers: {
				status: 200,
				body: homeUsersXml([
					{ id: 2001, title: 'Alice' },
					{ id: 2002, title: 'Bob' }
				])
			},
			sharedServers: {
				status: 200,
				body: sharedServersXml([{ userID: 2001, accessToken: 'token-alice' }])
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users.find((u) => u.id === 2001)).toBeDefined();
		expect(result.users.find((u) => u.id === 2002)).toBeUndefined();
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ id: 2002, title: 'Bob' });
		// Reason should name both the missing user and the user that does have access.
		expect(result.failures[0].reason).toMatch(/2002/);
		expect(result.failures[0].reason).toMatch(/2001/);
	});

	it('shared_servers returns zero elements — failure reason calls out shape/no-shares', async () => {
		const fetchFn = buildFetch({
			homeUsers: { status: 200, body: homeUsersXml([{ id: 2001, title: 'Alice' }]) },
			sharedServers: { status: 200, body: '<MediaContainer></MediaContainer>' }
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].reason).toMatch(/no <SharedServer> entries/i);
	});

	it('shared_servers entries are all malformed — failure reason flags shape change', async () => {
		const fetchFn = buildFetch({
			homeUsers: { status: 200, body: homeUsersXml([{ id: 2001, title: 'Alice' }]) },
			sharedServers: {
				status: 200,
				body: '<MediaContainer><SharedServer foo="bar" /></MediaContainer>'
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].reason).toMatch(/shape change/i);
	});

	it('parseXmlAttributes captures hyphenated and namespaced attribute names', async () => {
		// Regression smoke test for the broader attribute regex: a SharedServer
		// with xml:lang and data-foo attributes still yields a usable token.
		const fetchFn = buildFetch({
			homeUsers: { status: 200, body: homeUsersXml([{ id: 2001, title: 'Alice' }]) },
			sharedServers: {
				status: 200,
				body:
					'<MediaContainer>' +
					'<SharedServer xml:lang="en" data-foo="x" userID="2001" accessToken="tok-alice" />' +
					'</MediaContainer>'
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users.find((u) => u.id === 2001)).toMatchObject({
			accessToken: 'tok-alice'
		});
	});

	it('admin appears in home_users too — not duplicated, listed once with admin token', async () => {
		const fetchFn = buildFetch({
			homeUsers: {
				status: 200,
				body: homeUsersXml([
					{ id: ADMIN_ID, title: 'Admin User' },
					{ id: 2001, title: 'Alice' }
				])
			},
			sharedServers: {
				status: 200,
				body: sharedServersXml([{ userID: 2001, accessToken: 'token-alice' }])
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users.filter((u) => u.id === ADMIN_ID)).toHaveLength(1);
		expect(result.users[0]).toMatchObject({
			id: ADMIN_ID,
			accessToken: 'admin-token',
			isAdmin: true
		});
	});

	it('falls back to XML parsing when /api/v2/user returns XML instead of JSON', async () => {
		// Reproduces the production failure: plex.tv served XML for /api/v2/user
		// despite Accept: application/json. Content-Type header drives the parse
		// path, so this is what the fix actually keys off of.
		const fetchFn = buildFetch({
			adminUser: {
				status: 200,
				body: `<user id="${ADMIN_ID}" title="Admin User" username="admin" />`,
				contentType: 'application/xml; charset=utf-8'
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users[0]).toMatchObject({
			id: ADMIN_ID,
			title: 'Admin User',
			isAdmin: true
		});
	});

	it('uses XML path when /api/v2/user has no Content-Type at all', async () => {
		// Defensive case: some plex.tv mirrors omit Content-Type on this
		// endpoint. With case-insensitive parseXmlAttributes the same call
		// covers <user> and <User>, so a single fallback path handles both.
		const fetchFn = buildFetch({
			adminUser: {
				status: 200,
				body: `<User id="${ADMIN_ID}" title="Admin User" username="admin" />`
				// no contentType — header will be absent
			}
		});

		const result = await getManagedUsers(fetchFn);

		expect(result.users[0]).toMatchObject({ id: ADMIN_ID, isAdmin: true });
	});

	it('shared_servers HTTP 401 → throws PlexError', async () => {
		const fetchFn = buildFetch({
			homeUsers: { status: 200, body: homeUsersXml([{ id: 2001, title: 'Alice' }]) },
			sharedServers: { status: 401, body: 'Unauthorized' }
		});

		await expect(getManagedUsers(fetchFn)).rejects.toThrow(PlexError);
		await expect(
			getManagedUsers(fetchFn).catch((e: PlexError) => e.status)
		).resolves.toBe(401);
	});

	it('home_users HTTP 401 → throws PlexError', async () => {
		const fetchFn = buildFetch({
			homeUsers: { status: 401, body: 'Unauthorized' }
		});

		await expect(getManagedUsers(fetchFn)).rejects.toThrow(PlexError);
	});
});

describe('getUserAccessToken()', () => {
	beforeEach(() => {
		resetPlexCache();
		vi.clearAllMocks();
	});

	it('returns admin token when plexUserId is the server owner', async () => {
		const fetchFn = buildFetch({});

		const token = await getUserAccessToken(ADMIN_ID, fetchFn);
		expect(token).toBe('admin-token');
	});

	it('returns shared_servers accessToken for a home user with library access', async () => {
		const fetchFn = buildFetch({
			sharedServers: {
				status: 200,
				body: sharedServersXml([{ userID: 2001, accessToken: 'token-alice' }])
			}
		});

		const token = await getUserAccessToken(2001, fetchFn);
		expect(token).toBe('token-alice');
	});

	it('returns null when the user has no shared_servers entry', async () => {
		const fetchFn = buildFetch({
			sharedServers: { status: 200, body: sharedServersXml([]) }
		});

		const token = await getUserAccessToken(2001, fetchFn);
		expect(token).toBeNull();
	});

	it('returns null on plex.tv error rather than throwing', async () => {
		const fetchFn = buildFetch({
			sharedServers: { status: 500, body: 'Server error' }
		});

		const token = await getUserAccessToken(2001, fetchFn);
		expect(token).toBeNull();
	});
});
