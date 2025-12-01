"""Browse functionality for Apple Music integration."""
from typing import Any
from homeassistant.components.media_player import BrowseMedia
from homeassistant.components.media_player.const import MediaClass, MediaType
from urllib.parse import quote
from .utils import _get_json


def _search_results_to_browse(
    data: dict[str, Any],
    allowed: set[MediaClass] | None,
) -> list[BrowseMedia]:
    """Convert backend search results (dict) to a list of BrowseMedia items."""
    if not isinstance(data, dict):
        return []

    # Map server keys to MediaClass and to our content_id prefixes
    key_map: list[tuple[str, MediaClass, str]] = [
        ("albums", MediaClass.ALBUM, "album:"),
        ("artists", MediaClass.ARTIST, "artist:"),
        ("playlists", MediaClass.PLAYLIST, "playlist:"),
        ("songs", MediaClass.TRACK, "song:"),  # prefer "songs"
        ("tracks", MediaClass.TRACK, "song:"),  # fallback key name
    ]

    # If allowed is provided, only include those classes
    results: list[BrowseMedia] = []
    for key, mclass, prefix in key_map:
        if allowed and mclass not in allowed:
            continue
        items = data.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            # item can be a string name or a dict with more metadata
            if isinstance(item, str):
                title = item
            elif isinstance(item, dict):
                title = item.get("name") or item.get("title") or item.get("id") or "Unknown"
            else:
                continue

            # Build a thumbnail URL directly from the controller (fast and stable)
            thumb = None
            if mclass is MediaClass.ALBUM:
                thumb = f"{self._base_url}/artwork_album_thumb/128/{quote(title)}"

            # By default, search results should be expandable for containers and playable for tracks
            can_expand = mclass in (MediaClass.ALBUM, MediaClass.ARTIST, MediaClass.PLAYLIST)
            can_play = mclass in (MediaClass.TRACK, MediaClass.PLAYLIST)

            results.append(
                BrowseMedia(
                    title=title,
                    media_class=mclass,
                    media_content_id=f"{prefix}{title}",
                    media_content_type=MediaType.MUSIC if can_play else "library",
                    can_play=can_play,
                    can_expand=can_expand,
                    thumbnail=thumb,
                )
            )
    return results


async def async_browse_media(self, media_content_type: str | None = None, media_content_id: str | None = None) -> BrowseMedia:
    """Browse the media library, returning BrowseMedia objects."""
    if media_content_id:
        if media_content_id == "playlists":
            # Fetch on-demand if empty
            if not self._playlists:
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/playlists") as resp:
                        resp.raise_for_status()
                        self._playlists = await resp.json()
            children = [
                BrowseMedia(
                    title=f"🎧 {p}",
                    media_class=MediaClass.DIRECTORY,
                    media_content_id=f"playlist:{p}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                )
                for p in self._playlists
            ]
        elif media_content_id == "albums":
            # Fetch on-demand if empty
            if not self._albums:
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/albums") as resp:
                        resp.raise_for_status()
                        self._albums = await resp.json()
            children = [
                BrowseMedia(
                    title=f"💿 {a}",
                    media_class=MediaClass.ALBUM,
                    media_content_id=f"album:{a}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                    thumbnail=f"{self._base_url}/artwork_album_thumb/128/{quote(a)}",
                )
                for a in self._albums
            ]
        elif media_content_id == "artists":
            # Fetch on-demand if empty
            if not self._artists:
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/artists") as resp:
                        resp.raise_for_status()
                        self._artists = await resp.json()
            children = [
                BrowseMedia(
                    title=f"👤 {a}",
                    media_class=MediaClass.DIRECTORY,
                    media_content_id=f"artist:{a}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                )
                for a in self._artists
            ]
        elif media_content_id.startswith("playlist:"):
            playlist = media_content_id.replace("playlist:", "")
            async with timeout(10):
                async with self._session.get(f"{self._base_url}/songs/{quote(playlist)}") as resp:
                    resp.raise_for_status()
                    self._songs = await resp.json()
            children = [
                BrowseMedia(
                    title="Play playlist",
                    media_class=MediaClass.PLAYLIST,
                    media_content_id=f"play_playlist:{playlist}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                ),
                BrowseMedia(
                    title="Shuffle play",
                    media_class=MediaClass.PLAYLIST,
                    media_content_id=f"shuffle_playlist:{playlist}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                ),
            ] + [
                BrowseMedia(
                    title=f"{idx:02d}. {s}",
                    media_class=MediaClass.TRACK,
                    media_content_id=f"song:{s}||playlist={playlist}||idx={idx}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                )
                for idx, s in enumerate(self._songs, start=1)
            ]
        elif media_content_id.startswith("album:"):
            album = media_content_id.replace("album:", "")
            async with timeout(10):
                async with self._session.get(f"{self._base_url}/songs_by_album/{quote(album)}") as resp:
                    resp.raise_for_status()
                    songs = await resp.json()
            children = [
                BrowseMedia(
                    title="Play album",
                    media_class=MediaClass.ALBUM,
                    media_content_id=f"play_album:{album}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                ),
                BrowseMedia(
                    title="Shuffle play",
                    media_class=MediaClass.ALBUM,
                    media_content_id=f"shuffle_album:{album}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                ),
            ] + [
                BrowseMedia(
                    title=f"{idx:02d}. {s}",
                    media_class=MediaClass.TRACK,
                    media_content_id=f"song:{s}||album={album}||idx={idx}",
                    media_content_type=MediaType.MUSIC,
                    can_play=True,
                    can_expand=False,
                )
                for idx, s in enumerate(songs, start=1)
            ]
            return BrowseMedia(
                title=album,
                media_class=MediaClass.DIRECTORY,
                media_content_id=f"album:{album}",
                media_content_type="library",
                can_play=False,
                can_expand=True,
                children=children,
                children_media_class=MediaClass.TRACK,
            )
        elif media_content_id.startswith("artist:"):
            artist = media_content_id.replace("artist:", "")
            async with timeout(10):
                async with self._session.get(f"{self._base_url}/albums_by_artist/{quote(artist)}") as resp:
                    resp.raise_for_status()
                    albums = await resp.json()
            children = [
                BrowseMedia(
                    title=f"💿 {a}",
                    media_class=MediaClass.ALBUM,
                    media_content_id=f"album:{a}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                    thumbnail=f"{self._base_url}/artwork_album_thumb/128/{quote(a)}",
                )
                for a in albums
            ]
            return BrowseMedia(
                title=artist,
                media_class=MediaClass.DIRECTORY,
                media_content_id=f"artist:{artist}",
                media_content_type="library",
                can_play=False,
                can_expand=True,
                children=children,
                children_media_class=MediaClass.DIRECTORY,
            )
        else:
            children = []

        return BrowseMedia(
            title=(media_content_id.split(":")[0].capitalize() or "Apple Music"),
            media_class=MediaClass.DIRECTORY,
            media_content_id=media_content_id,
            media_content_type="library",
            can_play=False,
            can_expand=True,
            children=children,
            children_media_class=MediaClass.DIRECTORY,
        )

    # Root level
    return BrowseMedia(
        title="Apple Music",
        media_class=MediaClass.DIRECTORY,
        media_content_id="root",
        media_content_type="library",
        can_play=False,
        can_expand=True,
        children=[
            BrowseMedia(
                title="🎶 Playlists",
                media_class=MediaClass.DIRECTORY,
                media_content_id="playlists",
                media_content_type="library",
                can_play=False,
                can_expand=True,
            ),
            BrowseMedia(
                title="💿 Albums",
                media_class=MediaClass.DIRECTORY,
                media_content_id="albums",
                media_content_type="library",
                can_play=False,
                can_expand=True,
            ),
            BrowseMedia(
                title="👤 Artists",
                media_class=MediaClass.DIRECTORY,
                media_content_id="artists",
                media_content_type="library",
                can_play=False,
                can_expand=True,
            ),
        ],
        children_media_class=MediaClass.DIRECTORY,
    )
