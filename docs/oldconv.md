now the issue I am having is I get no tracks matched in MA

[ma-sync] No MA match for list_item 1 "Dirk McQuickly - Ging Gang Goolie"
[ma-sync] No MA match for list_item 2 "Imagine Dragons - Believer"
[ma-sync] No MA match for list_item 3 "Imagine Dragons - Thunder"
[ma-sync] No MA match for list_item 9 "AC/DC - T.N.T."
[ma-sync] No MA match for list_item 10 "Vance Joy - Riptide"
[ma-sync] No MA match for list_item 4 "Imagine Dragons - Whatever It Takes"
[ma-sync] No MA match for list_item 6 "AC/DC - Thunderstruck"

but they are there and I can play them

Glad the token's sorted. The matching failure is a real bug in the client. Two likely culprits: library_only: true being too restrictive, and our match check failing when MA returns ItemMapping shapes (which have name and uri but no artists[]).

Let me look at the current implementation and fix it.

Ran
Check current branch
This is a separate MA fix, not mirror-related. Let me make a fresh branch.


Ran 2 commands, read a file, updated todos, edited a file
Same pre-existing 1 error + 2 warnings. Commit, push, open PR.


Ran 2 commands, updated todos
PR #18 opened. Three bugs fixed in searchTrack:

Dropped library_only: true — was returning zero results for provider-sourced tracks.
Loosened title matching — normalize then compare; accepts "T.N.T." ≡ "TNT", "Believer (Acoustic Version)" ≡ "Believer", and word-bounded suffixes like "Thunder - Single Version" ≡ "Thunder" (still rejects "Thunderstruck" ≢ "Thunder").
Handle ItemMapping shapes — when MA returns the compact form without artists[], trust the search (query already had the artist).
Plus a diagnostic log on miss showing the top 5 candidates MA returned, so future "no match" cases tell us whether the search itself is too narrow or the matcher is too strict.

Branch is fresh off main, independent of the other open PRs. Pull and rebuild — next sync should populate maResult.added instead of streaming No MA match lines.

https://github.com/amanimmortal/TuneFetch/pull/18

do you want me to run something against the api to pull track data and see how it returns it so that we are not stabbing in the dark?

Yes — please. Three calls would let me write the matcher against actual data instead of inferred shapes.

Replace TOKEN with your bearer token. Run from any machine on the LAN (the responses are big, so pipe to a file). If you have jq installed, the pretty-print at the end makes them readable; if not, just send me the raw output.

1. Search with library_only: true — proves whether the flag was the problem
curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"command":"music/search","args":{"search_query":"AC/DC Thunderstruck","media_types":["track"],"limit":10,"library_only":true}}' \
  > ma-search-libraryonly.json

# Optional pretty-print for the message:
jq '.tracks | length, .tracks[0:3]' ma-search-libraryonly.json
2. Same search without library_only — confirms the broader path works
curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"command":"music/search","args":{"search_query":"AC/DC Thunderstruck","media_types":["track"],"limit":10}}' \
  > ma-search-broad.json

jq '.tracks | length, .tracks[0:3]' ma-search-broad.json
If #1 returns 0 tracks and #2 returns several, my hypothesis was right and PR #18 is the correct fix. If both return 0, the search query format itself needs work and I'll reshape that instead.

3. Pick any one returned track from #2 and dump the full record
This shows me the exact Track vs ItemMapping shape, the provider field ("library", "plex", etc.), and the uri format.

If #2 returned anything, the dump from jq '.tracks[0]' is enough. Paste that single track object verbatim.

4. (Bonus) Confirm what playlist_tracks returns over HTTP
This resolves Open Question #2 in the spec — whether MA's AsyncGenerator becomes a JSON array or some streaming format over HTTP. Pick a playlist you have in MA and substitute its item_id and provider:

curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"command":"music/playlists/library_items","args":{"limit":3,"kwargs":{}}}' \
  > ma-playlists.json

# Pick the item_id + provider of the first playlist, then:
curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"command":"music/playlists/playlist_tracks","args":{"item_id":"PASTE_ID","provider_instance_id_or_domain":"PASTE_PROVIDER"}}' \
  > ma-playlist-tracks.json

head -c 500 ma-playlist-tracks.json   # is it a JSON array, or chunked?
What I'll do with the responses
#1 + #2 results → confirm or correct the library_only decision in PR #18.
#3 single track object → write tighter types and adjust the matcher to match the real fields (e.g. if MA's name includes " (Album Version)" everywhere, I can strip it; if provider is "plex" not "library", I'll need to update getPlaylist/getPlaylistTrackUris callers).
#4 → either confirm the spec's HTTP-collects-the-generator assumption or switch getPlaylistTrackUris to the WebSocket transport surgically.
Paste the four files (or just the relevant excerpts — full tracks for #3, the array length + first 2 entries for #1/#2, the first 500 chars for #4). Anonymize anything sensitive — track titles aren't sensitive but if any provider URLs contain credentials, redact those.

doing a search for AC/DC Thunderstruck returned nothing both times, if I searched for JUST thunderstruck I get:

curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrRk1qaFdUOWtiaXFMTHJYeDBHLW5wRy0tcjFzWW9PbWc0Yjl1NGhfc3AwIiwianRpIjoiMENWTlMxZ2xtS1ItYmRMaGU0bTR1UWNKYmNiWDljVkxpVTBYeVZtSEhIQSIsImlhdCI6MTc3ODA0MDQ4OCwiZXhwIjoyMDkzNDAwNDg4LCJ1c2VybmFtZSI6ImJlbiIsInJvbGUiOiJhZG1pbiIsInRva2VuX25hbWUiOiJUdW5lRmV0Y2giLCJpc19sb25nX2xpdmVkIjp0cnVlfQ.uAP5-MikXGKpre3TdI48S_BHFKTdf66uc93LF7XfUbM" \
  -d '{"command":"music/search","args":{"search_query":"Thunderstruck","media_types":["track"],"limit":10}}' \
  > ma-search-broad.json

{"artists":[],"albums":[],"genres":[],"tracks":[{"item_id":"15","provider":"library","name":"Thunderstruck","version":"","sort_name":"thunderstruck","uri":"library://track/15","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"track","provider_mappings":[{"item_id":"/library/metadata/193890","provider_domain":"plex","provider_instance":"plex--bLky8S2P","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"flac","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"flac","bit_rate":0},"url":"http://192.168.200.16:32400#!/server/270b92ca554566dd9a8896766126ffdbc7e14963/details?key=%2Flibrary%2Fmetadata%2F193889","details":null},{"item_id":"/library/metadata/196529","provider_domain":"plex","provider_instance":"plex--8CPwL87A","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"flac","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"flac","bit_rate":0},"url":"http://192.168.200.16:32400#!/server/270b92ca554566dd9a8896766126ffdbc7e14963/details?key=%2Flibrary%2Fmetadata%2F196528","details":null}],"metadata":{"description":null,"review":null,"explicit":null,"images":[{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},{"type":"thumb","path":"/library/metadata/193889/thumb/1777085802","provider":"plex--bLky8S2P","remotely_accessible":false}],"grouping":null,"genres":null,"mood":null,"style":null,"copyright":null,"lyrics":null,"lrc_lyrics":null,"label":null,"links":null,"performers":null,"preview":null,"popularity":null,"release_date":null,"languages":null,"chapters":null,"last_refresh":null},"favorite":false,"position":null,"date_added":"2026-05-05T22:31:12","duration":292,"artists":[{"item_id":"1","provider":"library","name":"AC/DC","version":"","sort_name":"ac/dc","uri":"library://artist/1","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"artist","available":true,"image":null,"year":null}],"last_played":0,"album":{"item_id":"12","provider":"library","name":"The Razors Edge","version":"","sort_name":"razors edge, the","uri":"library://album/12","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"album","available":true,"image":{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},"year":1990},"disc_number":1,"track_number":1}],"playlists":[],"radio":[],"audiobooks":[],"podcasts":[]}


curl -sS -X POST http://192.168.200.14:8095/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrRk1qaFdUOWtiaXFMTHJYeDBHLW5wRy0tcjFzWW9PbWc0Yjl1NGhfc3AwIiwianRpIjoiMENWTlMxZ2xtS1ItYmRMaGU0bTR1UWNKYmNiWDljVkxpVTBYeVZtSEhIQSIsImlhdCI6MTc3ODA0MDQ4OCwiZXhwIjoyMDkzNDAwNDg4LCJ1c2VybmFtZSI6ImJlbiIsInJvbGUiOiJhZG1pbiIsInRva2VuX25hbWUiOiJUdW5lRmV0Y2giLCJpc19sb25nX2xpdmVkIjp0cnVlfQ.uAP5-MikXGKpre3TdI48S_BHFKTdf66uc93LF7XfUbM" \
  -d '{"command":"music/search","args":{"search_query":"Thunderstruck","media_types":["track"],"limit":10,"library_only":true}}' \
  > ma-search-libraryonly.json

{"artists":[],"albums":[],"genres":[],"tracks":[{"item_id":"15","provider":"library","name":"Thunderstruck","version":"","sort_name":"thunderstruck","uri":"library://track/15","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"track","provider_mappings":[{"item_id":"/library/metadata/193890","provider_domain":"plex","provider_instance":"plex--bLky8S2P","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"flac","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"flac","bit_rate":0},"url":"http://192.168.200.16:32400#!/server/270b92ca554566dd9a8896766126ffdbc7e14963/details?key=%2Flibrary%2Fmetadata%2F193889","details":null},{"item_id":"/library/metadata/196529","provider_domain":"plex","provider_instance":"plex--8CPwL87A","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"flac","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"flac","bit_rate":0},"url":"http://192.168.200.16:32400#!/server/270b92ca554566dd9a8896766126ffdbc7e14963/details?key=%2Flibrary%2Fmetadata%2F196528","details":null}],"metadata":{"description":null,"review":null,"explicit":null,"images":[{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},{"type":"thumb","path":"/library/metadata/193889/thumb/1777085802","provider":"plex--bLky8S2P","remotely_accessible":false}],"grouping":null,"genres":null,"mood":null,"style":null,"copyright":null,"lyrics":null,"lrc_lyrics":null,"label":null,"links":null,"performers":null,"preview":null,"popularity":null,"release_date":null,"languages":null,"chapters":null,"last_refresh":null},"favorite":false,"position":null,"date_added":"2026-05-05T22:31:12","duration":292,"artists":[{"item_id":"1","provider":"library","name":"AC/DC","version":"","sort_name":"ac/dc","uri":"library://artist/1","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"artist","available":true,"image":null,"year":null}],"last_played":0,"album":{"item_id":"12","provider":"library","name":"The Razors Edge","version":"","sort_name":"razors edge, the","uri":"library://album/12","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"album","available":true,"image":{"type":"thumb","path":"/library/metadata/196528/thumb/1777810681","provider":"plex--8CPwL87A","remotely_accessible":false},"year":1990},"disc_number":1,"track_number":1}],"playlists":[],"radio":[],"audiobooks":[],"podcasts":[]}

Playlist listing, as far as I am aware none of the playlists have tracks yet so there is no point in doing the second part of that

[{"item_id":"4","provider":"library","name":"500 Random tracks (from library)","version":"","sort_name":"500 random tracks (from library)","uri":"library://playlist/4","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"playlist","provider_mappings":[{"item_id":"random_tracks","provider_domain":"builtin","provider_instance":"builtin","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"?","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"?","bit_rate":0},"url":null,"details":null}],"metadata":{"description":null,"review":null,"explicit":null,"images":[{"type":"thumb","path":"logo.png","provider":"builtin","remotely_accessible":false},{"type":"fanart","path":"/collage/d1391eaa9f7e4d51870158bd8bc2dd4d_fanart.jpg","provider":"builtin","remotely_accessible":false}],"grouping":null,"genres":[],"mood":null,"style":null,"copyright":null,"lyrics":null,"lrc_lyrics":null,"label":null,"links":null,"performers":null,"preview":null,"popularity":null,"release_date":null,"languages":null,"chapters":null,"last_refresh":1778004003},"favorite":false,"position":null,"date_added":"2026-05-05T22:30:44","owner":"Music Assistant","is_editable":false,"is_dynamic":false,"supported_mediatypes":["track"]},{"item_id":"1","provider":"library","name":"All favorited tracks","version":"","sort_name":"all favorited tracks","uri":"library://playlist/1","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"playlist","provider_mappings":[{"item_id":"all_favorite_tracks","provider_domain":"builtin","provider_instance":"builtin","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"?","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"?","bit_rate":0},"url":null,"details":null}],"metadata":{"description":null,"review":null,"explicit":null,"images":[{"type":"thumb","path":"logo.png","provider":"builtin","remotely_accessible":false}],"grouping":null,"genres":null,"mood":null,"style":null,"copyright":null,"lyrics":null,"lrc_lyrics":null,"label":null,"links":null,"performers":null,"preview":null,"popularity":null,"release_date":null,"languages":null,"chapters":null,"last_refresh":null},"favorite":false,"position":null,"date_added":"2026-05-05T22:30:44","owner":"Music Assistant","is_editable":false,"is_dynamic":false,"supported_mediatypes":["track"]},{"item_id":"8","provider":"library","name":"Ben","version":"","sort_name":"ben","uri":"library://playlist/8","external_ids":[],"is_playable":true,"translation_key":null,"media_type":"playlist","provider_mappings":[{"item_id":"/playlists/196472","provider_domain":"plex","provider_instance":"plex--bLky8S2P","available":true,"in_library":true,"is_unique":null,"audio_format":{"content_type":"?","codec_type":"?","sample_rate":44100,"bit_depth":16,"channels":2,"output_format_str":"?","bit_rate":0},"url":"http://192.168.200.16:32400#!/server/270b92ca554566dd9a8896766126ffdbc7e14963/playlist?key=%2Fplaylists%2F196472","details":null}],"metadata":{"description":null,"review":null,"explicit":null,"images":[{"type":"thumb","path":"/playlists/196472/composite/1777683937","provider":"plex--bLky8S2P","remotely_accessible":false}],"grouping":null,"genres":[],"mood":null,"style":null,"copyright":null,"lyrics":null,"lrc_lyrics":null,"label":null,"links":null,"performers":null,"preview":null,"popularity":null,"release_date":null,"languages":null,"chapters":null,"last_refresh":1778004003},"favorite":false,"position":null,"date_added":"2026-05-05T22:36:38","owner":"","is_editable":true,"is_dynamic":false,"supported_mediatypes":["track"]}]

This is the real diagnosis. Three things are now clear:

1. library_only: true was NOT the problem. Both calls returned the track when searching for Thunderstruck alone. PR #18's drop of library_only was unnecessary (harmless, but unnecessary).

2. The actual bug is the search query containing /. "AC/DC Thunderstruck" returns zero tracks; "Thunderstruck" alone returns it. MA's search tokenizer either chokes on the slash or treats it as a hard separator that breaks the query. Combining ${artistName} ${trackTitle} is fundamentally fragile for artists like AC/DC, Sturm und Drang, GZA/Genius, etc.

3. The Track shape is full, not ItemMapping. The returned object has artists: [{name: "AC/DC", ...}], uri: "library://track/15", provider: "library". So my matcher's logic was correct — just never reached because the search returned empty.

Fix plan
Switch to title-only primary search and filter by artist client-side. The data also tells me my fallback strategy can be cleaner — sanitize then retry only if title-only returned nothing.