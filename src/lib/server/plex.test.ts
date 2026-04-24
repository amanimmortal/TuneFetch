/**
 * Unit tests for getManagedUsers() — plex.ts
 *
 * Strategy:
 *   - vi.mock('./settings') so readConfig() never hits the database.
 *   - Inject a typed mock fetchFn into getManagedUsers() to control HTTP responses.
 *   - All assertions target the post-fix return shape: { users, failures }.
 *
 * Test cases per handover doc Section 8.1:
 *   1. Happy path              — 2 users, both tokens found → 2 users, 0 failures
 *   2. Step 1 HTTP error       — /home/users returns 401    → throws PlexError(401)
 *   3. Step 2 HTTP error (one) — one user 200, one user 403 → 1 user, 1 failure
 *   4. Step 2 missing token    — switch OK, no authenticationToken attr → 1 failure
 *   5. Step 2 exception        — fetchFn throws AbortError  → 1 failure with "aborted"
 *   6. All users fail          — all 4 fail in step 2       → { users: [], failures: [x4] }
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getManagedUsers, PlexError } from './plex';
import type { PlexManagedUser } from './plex';

// ── Types for the post-fix API ────────────────────────────────────────────────

interface PlexManagedUserFailure {
	id: number;
	title: string;
	reason: string;
}

interface GetManagedUsersResult {
	users: PlexManagedUser[];
	failures: PlexManagedUserFailure[];
}

// ── Module mock: settings ─────────────────────────────────────────────────────

vi.mock('./settings', () => ({
	getSetting: vi.fn((key: string) => {
		if (key === 'plex_url') return 'http://plex.local:32400';
		if (key === 'plex_admin_token') return 'test-admin-token';
		return null;
	}),
	SETTING_KEYS: {
		PLEX_URL: 'plex_url',
		PLEX_ADMIN_TOKEN: 'plex_admin_token',
	},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResponse(status: number, body: string): Response {
	return new Response(body, { status });
}

function homeUsersXml(users: Array<{ id: number; title: string }>): string {
	const elements = users
		.map((u) => `<User id="${u.id}" title="${u.title}" />`)
		.join('\n');
	return `<MediaContainer>\n${elements}\n</MediaContainer>`;
}

function switchSuccessXml(token: string): string {
	return `<MediaContainer><User authenticationToken="${token}" /></MediaContainer>`;
}

function switchSuccessNoTokenXml(): string {
	return `<MediaContainer><User someOtherAttr="value" /></MediaContainer>`;
}

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getManagedUsers()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Test 1: Happy path ────────────────────────────────────────────────────

	it('happy path — returns 2 users and 0 failures when all switch calls succeed', async () => {
		const twoUsers = [
			{ id: 1, title: 'Alice' },
			{ id: 2, title: 'Bob' },
		];

		const mockFetch: FetchFn = vi.fn(async (url) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/home/users') && !urlStr.includes('/switch')) {
				return makeResponse(200, homeUsersXml(twoUsers));
			}
			if (urlStr.includes('/1/switch')) return makeResponse(200, switchSuccessXml('token-alice'));
			if (urlStr.includes('/2/switch')) return makeResponse(200, switchSuccessXml('token-bob'));
			return makeResponse(500, 'unexpected URL');
		});

		const result = (await getManagedUsers(mockFetch)) as unknown as GetManagedUsersResult;

		expect(result.users).toHaveLength(2);
		expect(result.users[0]).toMatchObject({ id: 1, title: 'Alice', accessToken: 'token-alice' });
		expect(result.users[1]).toMatchObject({ id: 2, title: 'Bob', accessToken: 'token-bob' });
		expect(result.failures).toHaveLength(0);
	});

	// ── Test 2: Step 1 HTTP error ─────────────────────────────────────────────

	it('step 1 HTTP 401 — throws PlexError with status 401', async () => {
		const mockFetch: FetchFn = vi.fn(async () => makeResponse(401, 'Unauthorized'));

		await expect(getManagedUsers(mockFetch)).rejects.toThrow(PlexError);
		await expect(getManagedUsers(mockFetch)).rejects.toMatchObject({ status: 401 });
	});

	// ── Test 3: Step 2 HTTP error for one user ────────────────────────────────

	it('step 2 HTTP 403 for one user — returns 1 user and 1 failure', async () => {
		const twoUsers = [
			{ id: 10, title: 'Carol' },
			{ id: 11, title: 'Dave' },
		];

		const mockFetch: FetchFn = vi.fn(async (url) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/home/users') && !urlStr.includes('/switch')) {
				return makeResponse(200, homeUsersXml(twoUsers));
			}
			if (urlStr.includes('/10/switch')) return makeResponse(200, switchSuccessXml('token-carol'));
			if (urlStr.includes('/11/switch')) return makeResponse(403, 'Forbidden');
			return makeResponse(500, 'unexpected');
		});

		const result = (await getManagedUsers(mockFetch)) as unknown as GetManagedUsersResult;

		expect(result.users).toHaveLength(1);
		expect(result.users[0]).toMatchObject({ id: 10, title: 'Carol', accessToken: 'token-carol' });
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ id: 11, title: 'Dave' });
		expect(result.failures[0].reason).toMatch(/403/);
	});

	// ── Test 4: Step 2 missing authenticationToken ────────────────────────────

	it('step 2 OK but no authenticationToken attr — produces failure with XML snippet', async () => {
		const oneUser = [{ id: 20, title: 'Eve' }];

		const mockFetch: FetchFn = vi.fn(async (url) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/home/users') && !urlStr.includes('/switch')) {
				return makeResponse(200, homeUsersXml(oneUser));
			}
			if (urlStr.includes('/20/switch')) return makeResponse(200, switchSuccessNoTokenXml());
			return makeResponse(500, 'unexpected');
		});

		const result = (await getManagedUsers(mockFetch)) as unknown as GetManagedUsersResult;

		expect(result.users).toHaveLength(0);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ id: 20, title: 'Eve' });
		// reason should contain the raw XML so the dev can diagnose a shape change
		expect(result.failures[0].reason).toMatch(/someOtherAttr/);
	});

	// ── Test 5: Step 2 exception (AbortError) ────────────────────────────────

	it('step 2 throws AbortError — produces failure with "aborted" in reason', async () => {
		const oneUser = [{ id: 30, title: 'Frank' }];

		const mockFetch: FetchFn = vi.fn(async (url) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/home/users') && !urlStr.includes('/switch')) {
				return makeResponse(200, homeUsersXml(oneUser));
			}
			throw new DOMException('The operation was aborted.', 'AbortError');
		});

		const result = (await getManagedUsers(mockFetch)) as unknown as GetManagedUsersResult;

		expect(result.users).toHaveLength(0);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ id: 30, title: 'Frank' });
		// describeFetchError uses error.message + [code], not error.name.
		// DOMException AbortError has message "The operation was aborted." and numeric code 20.
		expect(result.failures[0].reason).toMatch(/aborted/i);
	});

	// ── Test 6: All users fail (production bug shape) ─────────────────────────

	it('all 4 users fail in step 2 — returns { users: [], failures: [x4] }', async () => {
		const fourUsers = [
			{ id: 101, title: 'User1' },
			{ id: 102, title: 'User2' },
			{ id: 103, title: 'User3' },
			{ id: 104, title: 'User4' },
		];

		const mockFetch: FetchFn = vi.fn(async (url) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/home/users') && !urlStr.includes('/switch')) {
				return makeResponse(200, homeUsersXml(fourUsers));
			}
			// All switch calls fail with 400 (e.g. PIN required)
			return makeResponse(400, 'PIN required');
		});

		const result = (await getManagedUsers(mockFetch)) as unknown as GetManagedUsersResult;

		// This is the exact production bug shape: found 4, returned 0
		expect(result.users).toHaveLength(0);
		expect(result.failures).toHaveLength(4);
		for (const f of result.failures) {
			expect(f.reason).toMatch(/400/);
		}
	});
});
