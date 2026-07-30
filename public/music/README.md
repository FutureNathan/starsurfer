# Music

The player runs *named playlists*, Minecraft-style: `manifest.json` names
them, one is the default, and the pause menu's sound tab switches between
them. One track plays, then a couple of minutes of vacuum, then another —
shuffled without repeats.

Two playlists are waiting for their files — **Synthwave Chill** (the default)
and **Noor's Mixtape** — and a third, **STARSURFER Originals**, carries three
ambient pieces composed for the project (CC0, keep or delete). A playlist
with no files simply plays nothing until they arrive, and a listed file that
is missing is quietly skipped, so nothing here can break the site.

## Adding the files

This project deploys from GitHub, so the files have to be *in the repo* —
a cloud build cannot see anyone's Downloads folder:

1. On github.com, open this folder (`public/music/`) and use
   **Add file → Upload files**; drag the MP3s in and commit.
2. Add one line per track to `manifest.json` under the right playlist:

```json
{
  "default": "Synthwave Chill",
  "playlists": [
    { "name": "Synthwave Chill", "tracks": [
      { "file": "some-song.mp3", "title": "Some Song", "artist": "Somebody" }
    ] },
    { "name": "Noor's Mixtape", "tracks": [] }
  ]
}
```

Mind the licence: only upload music you have the right to publish — the site
serves these files to everyone. Safe sources: Pixabay Music (free, no
attribution), OpenGameArt filtered to CC0, incompetech (CC-BY — put the
credit in the `artist` field). Actual Minecraft music is copyrighted; don't.
