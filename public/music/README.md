# Music

The player is built in; the tracks are not in the repo, so that the project
never ships audio it does not own. Adding music is a three-minute job:

1. Go to **[freepd.com](https://freepd.com)** — everything there is **CC0 /
   public domain**: free for any use, no attribution required, nothing to
   clear. The *Calming* and *Page* categories are the closest fit to the
   relaxing, Minecraft-adjacent mood this scene wants. (Pixabay Music and
   OpenGameArt's CC0 filter are good alternatives.) **Do not use actual
   Minecraft music** — C418's soundtrack is copyrighted.
2. Download two or three tracks you like as MP3 and drop the files into this
   folder.
3. List them in `manifest.json` here:

```json
[
  { "file": "floating-cities.mp3", "title": "Floating Cities", "artist": "Kevin MacLeod" },
  { "file": "another-track.mp3",   "title": "Another Track",   "artist": "Somebody" }
]
```

That is the whole job — no code changes. The player shuffles the list without
repeats, plays one track, then leaves a couple of minutes of vacuum before the
next, the way Minecraft does; the title and artist show on the pause menu's
sound tab while a track plays. A file listed here but missing from the folder
is quietly dropped from the rotation, so a half-finished manifest breaks
nothing.
