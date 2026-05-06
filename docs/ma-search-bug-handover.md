# Music Assistant Search Track Bug Handover

## Issue Summary
In the Music Assistant (MA) integration, the track matching frequently fails with "No MA match" for valid tracks that exist in the library.

The root cause was identified: MA's search tokenizer fails when the search query contains certain characters like `/`. Combining `${artistName} ${trackTitle}` into a single search query is fundamentally fragile for artists with punctuation in their names (e.g., "AC/DC", "Sturm und Drang", "GZA/Genius"). When querying `"AC/DC Thunderstruck"`, MA returns 0 tracks, but querying `"Thunderstruck"` alone returns the correct track.

The existing matcher logic (title matching and client-side artist matching) is correct since MA returns a full `Track` shape containing `artists` and `uri`. However, this matcher logic is never reached because the initial search result is empty due to the tokenizer bug in MA.

## Files to Modify
- `src/lib/server/music-assistant.ts`

## Proposed Fix
Switch to a **title-only** primary search and filter by artist client-side. The data shows that fallback strategies can be cleaner: sanitize the query and then retry only if the title-only search returns nothing. The primary method should avoid combining the raw artist name into the search query sent to MA.

### Code Snippets of What Needs to Change

In `src/lib/server/music-assistant.ts`, update the `searchTrack` function:

**Current implementation:**
```typescript
export async function searchTrack(
	artistName: string,
	trackTitle: string
): Promise<string | null> {
	const results = await command<MaSearchResults>('music/search', {
		search_query: `${artistName} ${trackTitle}`, // Fragile for names like AC/DC
		media_types: ['track'],
		limit: 25
	});
    // ...
```

**Recommended implementation:**
```typescript
export async function searchTrack(
	artistName: string,
	trackTitle: string
): Promise<string | null> {
    // Primary search: Title-only to prevent MA tokenizer issues with artist names
	let results = await command<MaSearchResults>('music/search', {
		search_query: trackTitle,
		media_types: ['track'],
		limit: 25
	});

	let tracks = results.tracks ?? [];
    
    // Fallback: If title-only fails, retry with sanitized artist + title
    if (tracks.length === 0) {
        const sanitizedArtist = artistName.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
        if (sanitizedArtist) {
            results = await command<MaSearchResults>('music/search', {
                search_query: `${sanitizedArtist} ${trackTitle}`,
                media_types: ['track'],
                limit: 25
            });
            tracks = results.tracks ?? [];
        }
    }

	if (tracks.length === 0) {
		console.log(`[ma-sync] MA search returned 0 tracks for "${artistName} - ${trackTitle}"`);
		return null;
	}

	const wantTitle = normalizeForMatch(trackTitle);

	for (const t of tracks) {
		if (!t.uri || !t.name) continue;
		if (!titleMatches(t.name, wantTitle)) continue;
		if (!artistMatches(t.artists, artistName)) continue;
		return t.uri;
	}

    // ... rest of the function remains the same
```
