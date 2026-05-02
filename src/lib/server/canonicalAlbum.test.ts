import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ getDb: vi.fn() }));

import { resolveCanonicalAlbum, recordingPenalty } from './canonicalAlbum';
import type { MBRecording, MBReleaseGroupNested } from './musicbrainz';

function makeRec(overrides: Partial<MBRecording> = {}): MBRecording {
	return { id: 'rec-1', title: 'Test Track', ...overrides };
}

function rg(
	id: string,
	primaryType: string | null,
	secondaryTypes: string[],
	date: string
): MBReleaseGroupNested {
	return {
		id,
		title: `RG ${id}`,
		'primary-type': primaryType,
		'secondary-types': secondaryTypes,
		'first-release-date': date
	};
}

function release(rgData: MBReleaseGroupNested) {
	return { id: `rel-${rgData.id}`, title: rgData.title, 'release-group': rgData };
}

describe('resolveCanonicalAlbum', () => {
	it('returns tier 1 for a single Album release-group', () => {
		const result = resolveCanonicalAlbum(
			makeRec({ releases: [release(rg('rg-1', 'Album', [], '1970-01-01'))] })
		);
		expect(result?.tier).toBe(1);
		expect(result?.releaseGroupMbid).toBe('rg-1');
		expect(result?.year).toBe('1970');
	});

	it('picks Album (tier 1) over Live and Compilation release-groups', () => {
		const result = resolveCanonicalAlbum(
			makeRec({
				releases: [
					release(rg('rg-live', 'Album', ['Live'], '1968-01-01')),
					release(rg('rg-comp', 'Album', ['Compilation'], '1969-01-01')),
					release(rg('rg-album', 'Album', [], '1970-01-01'))
				]
			})
		);
		expect(result?.tier).toBe(1);
		expect(result?.releaseGroupMbid).toBe('rg-album');
	});

	it('falls back to Compilation (tier 3) when only Live and Compilation exist', () => {
		const result = resolveCanonicalAlbum(
			makeRec({
				releases: [
					release(rg('rg-live', 'Album', ['Live'], '1968-01-01')),
					release(rg('rg-comp', 'Album', ['Compilation'], '1972-06-01'))
				]
			})
		);
		expect(result?.tier).toBe(3);
		expect(result?.releaseGroupMbid).toBe('rg-comp');
	});

	it('returns tier 2 for an EP release-group', () => {
		const result = resolveCanonicalAlbum(
			makeRec({ releases: [release(rg('rg-ep', 'EP', [], '1975-03-01'))] })
		);
		expect(result?.tier).toBe(2);
	});

	it('returns tier 2 for a Single release-group', () => {
		const result = resolveCanonicalAlbum(
			makeRec({ releases: [release(rg('rg-single', 'Single', [], '1966-01-01'))] })
		);
		expect(result?.tier).toBe(2);
	});

	it('does not drop Soundtrack (not noise) — falls to tier 4 when only option', () => {
		// Soundtrack is not in BAD_SECONDARY, so it survives the clean filter.
		// But primary=Album with secondary=['Soundtrack'] fails Tier 1 (has secondary),
		// Tier 2 (primary is Album), and Tier 3 (secondary is not Compilation).
		const result = resolveCanonicalAlbum(
			makeRec({ releases: [release(rg('rg-ost', 'Album', ['Soundtrack'], '1980-01-01'))] })
		);
		expect(result?.tier).toBe(4);
		expect(result?.releaseGroupMbid).toBe('rg-ost');
	});

	it('picks the earliest date among same-tier Albums', () => {
		const result = resolveCanonicalAlbum(
			makeRec({
				releases: [
					release(rg('rg-later', 'Album', [], '1980-05-01')),
					release(rg('rg-earlier', 'Album', [], '1975-03-01'))
				]
			})
		);
		expect(result?.releaseGroupMbid).toBe('rg-earlier');
		expect(result?.year).toBe('1975');
	});

	it('deduplicates the same release-group appearing via multiple releases', () => {
		const rgData = rg('rg-1', 'Album', [], '1970-01-01');
		const result = resolveCanonicalAlbum(
			makeRec({ releases: [release(rgData), release(rgData)] })
		);
		expect(result?.releaseGroupMbid).toBe('rg-1');
		expect(result?.tier).toBe(1);
	});

	it('returns null for a recording with no releases', () => {
		expect(resolveCanonicalAlbum(makeRec({ releases: [] }))).toBeNull();
	});

	it('returns null for a recording with no release-groups embedded', () => {
		expect(
			resolveCanonicalAlbum(
				makeRec({ releases: [{ id: 'rel-1', title: 'No RG' }] })
			)
		).toBeNull();
	});
});

describe('recordingPenalty', () => {
	it('returns 0 for a clean title', () => {
		expect(recordingPenalty(makeRec({ title: 'Hey Jude' }))).toBe(0);
	});

	it('penalises a title containing "live"', () => {
		expect(recordingPenalty(makeRec({ title: 'Hey Jude (Live)' }))).toBe(40);
	});

	it('penalises disambiguation matching regex', () => {
		expect(
			recordingPenalty(makeRec({ title: 'Hey Jude', disambiguation: 'acoustic version' }))
		).toBe(40);
	});

	it('penalises both title and disambiguation when both match', () => {
		expect(
			recordingPenalty(makeRec({ title: 'Hey Jude (Live)', disambiguation: 'karaoke version' }))
		).toBe(80);
	});

	it('penalises short recordings (< 30s)', () => {
		expect(recordingPenalty(makeRec({ title: 'Intro', length: 15_000 }))).toBe(30);
	});

	it('penalises very long recordings (> 15 min)', () => {
		expect(recordingPenalty(makeRec({ title: 'Suite', length: 16 * 60_000 }))).toBe(30);
	});

	it('does not penalise a normal-length recording', () => {
		expect(recordingPenalty(makeRec({ title: 'Normal', length: 3 * 60_000 }))).toBe(0);
	});
});
