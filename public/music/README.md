# Music

Three original tracks ship with the project — **Drift**, **Low Gravity** and
**Afterglow** — composed and rendered offline for STARSURFER (additive
felt-piano, generated reverb, everything diatonic and slow). They are released
CC0 / public domain along with the rest of the repo's own work: use them for
anything.

The player shuffles `manifest.json` without repeats, plays one track, then
leaves a couple of minutes of vacuum before the next, the way Minecraft does;
the title shows on the pause menu's sound tab while a track plays.

## Swapping or adding tracks

1. Find music that is genuinely free. Good sources as of 2026:
   - **Pixabay Music** (pixabay.com/music) — free for any use, no attribution.
   - **OpenGameArt.org** — filter licence to **CC0**.
   - **incompetech.com** (Kevin MacLeod) — CC-BY: free with a credit line,
     which the sound tab's artist field can carry.
   - **Do not use actual Minecraft music** — C418's soundtrack is copyrighted.
     (freepd.com was the original recommendation here; it has since closed.)
2. Drop the MP3 files into this folder.
3. List them in `manifest.json`:

```json
[
  { "file": "drift.mp3", "title": "Drift", "artist": "a STARSURFER original" },
  { "file": "your-track.mp3", "title": "Your Track", "artist": "Somebody" }
]
```

That is the whole job — no code changes. A file listed here but missing from
the folder is quietly dropped from the rotation, so a half-finished manifest
breaks nothing.
