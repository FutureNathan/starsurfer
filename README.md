# STARSURFER

An astronaut surfing a sea of cosmic dust through a galaxy of stars. WebGPU,
Babylon.js, hand-written WGSL. Everything you see is generated on the GPU at load
time — there are no textures, no meshes, no HDRIs and no animation data in this
repository.

**▶ [starsurfer.nathantowianski.com](https://starsurfer.nathantowianski.com)**

> Needs WebGPU. Chrome or Edge 113+, Firefox 141+, Safari 26+ on the desktop;
> Chrome 121+ on Android; iOS 26+ on an iPhone or iPad. There is no WebGL fallback
> by design — without `navigator.gpu` the page says so and stops, and says which
> browsers do have it.
>
> Phones and tablets get on-screen controls and a reduced quality tier
> automatically. See [On a phone](#on-a-phone) for what that trades away.

---

## Controls

| | |
|---|---|
| Click | capture the pointer |
| `W` `A` `S` `D` | move, relative to the camera |
| Mouse | look · **Wheel** zoom |
| `Shift` | sprint |
| **Right mouse (hold)** | star-surf — carve across the dust sea and throw a luminous wake |
| `1` – `5` | the five powers (`2` is a held cast) |
| `F1` or `` ` `` | settings and performance overlay |

On a touchscreen the on-screen controls appear instead, and nothing else changes —
they write into the same input struct the keyboard and mouse do.

| | |
|---|---|
| Drag anywhere | look |
| Left thumbstick | **the throttle** — nudge to walk, most of the way to run, out to the ring to surf |
| Two-finger pinch | zoom |
| Five ringed buttons (bottom right) | the powers · **ION** is held |
| ⚙ (top right) | settings and performance overlay |

There is no surf button, and that is not just one fewer control to hit. A button
makes surfing a mode you are in or out of; a throttle makes speed something you
lean into, which is what the scene is about. It also frees the corner — the one
spot a thumb reaches without moving the hand — for the powers.

The gear change has hysteresis, and needs it. The stick's ring is drawn wherever
the thumb lands in the lower-left quadrant rather than at a fixed spot, so it can
be grabbed without looking, and its centre is dragged along if the thumb runs past
the ring so it can never run out of travel mid-turn. That last part means a thumb
still travelling outward is pinned at full deflection by definition — so a
threshold placed near the edge would sit right under a resting thumb and the
astronaut would flicker between a walk and a nineteen-metre-a-second carve. Surf
engages at 0.84 of travel and does not release until 0.62.

Append `?touch=1` to force the controls on for a look at the layout from a
desktop, or `?touch=0` to force them off.

The overlay exposes every art parameter as a live slider — the star's bearing and
elevation, the galactic band's tilt and core bearing, aurora strength, the dust's
own glow, displacement depth, tonemap curve, exposure — plus a frame-time graph
with median / 95th / 1% low, draw calls, triangles and a per-system CPU
breakdown. Every system can be toggled off individually, and there are debug
views for surface normals, fine normals, depth, cascade coverage, the
displacement buffer and the footprint field.

---

## What it does

### The dust sea

A nested-ring geometry clipmap: 8 rings, 8.5 cm inner spacing, ~870 m radius,
333k triangles — **one static mesh, one draw call**. Vertices carry only
`(gridIndex, ringLevel)`; world placement, CDLOD morphing and displacement all
happen in the vertex shader, so there is no CPU rebuild and no per-frame upload.

The heightfield underneath it is layered gradient noise with analytic
derivatives, split across two layers that take opposite positions on anisotropy —
and that split is what makes the surface read as drifting grains rather than as a
wind-carved field. The macro layer is near-isotropic: broad rolling swells with
no prevailing grain, because nothing out here blows. The fine layer is stretched
hard along the drift bearing, so metre-scale filaments stream across those swells
the way gas does in a nebula. The macro half bakes once into a 4096² R32F texture
over a 2048 m field (0.5 m per texel) plus a 2048² RGBA16F auxiliary of slopes,
outcrop mask and exposure, and is mirrored back to the CPU — so character
grounding samples exactly the surface that is drawn rather than a
re-implementation of it. The fine half is evaluated live, with exact analytic
derivatives, and is never baked at all. (Every figure here is the desktop tier;
the mobile tier halves each of these — see [On a phone](#on-a-phone).)

### Dust shading

Cosmic dust is a hard material to light: its albedo is **0.085 / 0.062 / 0.155**,
so reflected light alone leaves it with no readable form under one small star.
The material answers that the way the real thing would — it glows. A
nebula-violet emission wells out of the cavities and up the shaded flanks, and
freshly thrown or charged mass burns warm gold on top of it. The star's own
contribution is layered over that: multi-scale normals (baked macro slope,
analytic filaments and ripples, three tiled detail scales, triplanar on steep
faces) over wrapped diffuse, a back-scatter subsurface term, GGX specular, SH
ambient with an iteratively-solved dust bounce, and procedural view-dependent
glints gated on grazing angle. Compression, displacement and crystalline charge
are surface state channels the material reads rather than separate materials.

The lighting split is deliberately two-sided: the star is warm and what fills the
shadows is violet. With the sky black, almost none of that fill comes from above —
sky irradiance is a fraction of a percent of direct on an upward-facing normal, and
the dominant source is the glowing sea itself, arriving from below at around 20%.
The ground lights the astronaut, not the other way round, and nothing in the frame
goes black.

Shadows are three hand-rolled cascades with world-space PCSS — blocker search,
penumbra estimate, rotated Poisson filter — texel-snapped in world space and
stabilised against a rotation-invariant bounding sphere. One distant star means
one hard shadow, and with no sky dome to soften the terminator that shadow is the
strongest single form cue in the frame. Babylon's own cascade generator can't be
used here: the terrain has no CPU geometry matching what is drawn, so every
caster registers the vertex program it is actually rendered with.

### Displacement

A persistent, additive terrain state buffer: two 2048² RGBA16F targets covering
80 m (3.9 cm texels), ping-ponged by a single full-screen pass per frame that
scrolls, relaxes and splats in one dispatch. Addressing is toroidal — a texel's
UV is `fract(worldXZ / size)` — so the window follows the player without ever
copying the buffer, and newly exposed texels are detected and zeroed by the same
pass.

Channels are depression depth, displaced mass, compression and crystalline
charge. That second channel is what separates a trail with raised berms from a
flat footprint decal; the fourth is what a power leaves behind, and it drives
both a vitrified violet albedo and a gold emission, so a scar stays visible from
across the field. Refill is anisotropic diffusion (loose berms slump three times
faster than a packed trench floor) plus berm-into-depression slump, drift-driven
infill from upwind, and slow exponential decay: **~71% of trail depth survives a
minute**, visibly spreading and softening as it goes. Charge is the one channel
meant to feel permanent within a session and decays on a fifteen-minute constant.

The displacement is real geometry in the beauty pass *and* in all three shadow
cascades through one shared include, so trails self-shadow and berms break the
silhouette. Feet, the surf wake and all five powers write through one `brush()`
call into the same buffer.

### The astronaut

Fully procedural — no rig file, no animation clips, no authored mesh. A 19-bone
skeleton whose bind pose is a table of numbers, geometry lofted from that table
at load (helmet, gold faceplate, pressure suit, life-support pack, gloves, boots)
and locomotion solved from the motion state rather than played back. The
nineteenth bone is the board, and it is not parented to the figure at all: it is
driven from the surface it is planing on, and the legs are solved down to it.

Eight material slots carry the whole figure — pressure garment, soft goods, gold
mirror faceplate, hard shell, glove, gold trim, bare metal, board deck. Only the
faceplate emits; the trim is gold that reflects, because a strip that thin above
the bloom threshold stops reading as an inlay and becomes a line drawn in front of
the suit.
Seven of the eight resolve their colour through the shared palette module; the
metals do not, on purpose, because a conductor's normal-incidence reflectance is
a measured optical constant rather than a design choice.

Feet plant. A distance-driven stance/swing machine writes a foot's world position
exactly once, on touchdown, and holds it absolutely fixed while two-bone IK
reaches for it — a planted foot cannot slide because nothing in the code is able
to move it. Gait phase advances with ground travelled, so stride length and
ground speed are the same number by construction.

The soft goods are Verlet cloth on three panels — the lower torso and two sleeves
— with distance, bending and shape-memory constraints, nine body collision
capsules, and apparent wind that is the field drift minus the character's own
velocity. Every pin rate is high, deliberately: a pressure garment does not
billow, and what the solver is buying here is not motion but the collision pass
keeping a panel off the leg capsules when the legs cross under it, plus a couple
of centimetres of lag so the hem does not look welded to the hips. 516 simulated
nodes render as 3,462 surface vertices through Catmull-Rom reconstruction in the
vertex shader, so tessellation and simulation cost are fully decoupled. The
frayed nap of multi-layer insulation at the neck seam and the glove cuffs is a
partial torus emitted ten times per band and alpha-tested against a hashed fibre
field — 14 mm long, which is why ten shells is already past visible banding.

One small 48×64 texture carries everything to the GPU: rows 0–3 are bone
matrices, rows 4+ are simulated cloth nodes. One upload per frame, no allocation.

### Star-surf

The wake is a **swept mesh, not a particle effect**. Its spine is the path the
board has taken, resampled every 30 cm into a 96×3 data texture; the mesh itself
is a static 128×18 lattice of `(column, row, side)` and every vertex is placed in
the vertex shader, so a 16-metre wake and a 2-metre one cost the same buffer and
the same upload.

The cross-section is a breaking wave integrated from a turning tangent — the
tangent sweeps from just below horizontal at the base to 284° at the tip, so one
`curl` parameter runs continuously from a low heaped bank to a lip that hangs
back across its own face. Amplitude and curl resolve per side from the carve, so
the outside of a turn takes nearly all the mass. Peak wall is 2.4 m at a
full-speed carve and collapses 0.88 s after it is laid, which makes wake length
`life × speed` with no second constant. Normals are differenced out of the same
`wakePoint` the geometry uses, so they cannot disagree with it.

The wake is luminous, and its brightness is a readout of how hard the board is
being driven. The wall wells nebula violet at a linear radiance of 8; the lip —
the hottest, freshest mass — reaches warm gold at 10, which clears both the lit
dust at 5 and the bloom threshold at 3, so the crest is the brightest and the
warmest point on the whole structure. On a straight run the crest sits at 3,
right in the bloom's soft knee, and barely glows.

Two grain populations come off the same spine — a dense slow curtain hugging the
crest, and ballistic grains flung clear that burn at fourteen times starlight
white, the brightest emissive in the palette — emitted at *fractional* positions
along it, plus screen-space speed streaks and camera shake on a loaded edge. The
streaks are the same grains seen closer: a screen-space strand is one of them
smeared along its own path, stated at the radiance that smear leaves it with.

### The five powers

One plasma material, one mesh, one draw, eight strands of 64 columns. Four of the
five move a coherent body of ignited dust and are structurally the same object: a
swept surface along a spine, with a radius, a parallel-transported frame and an
ignition-front channel — the same construction as the surf wake. A strand that is
not in use is switched off by zeroing its rows, so the draw count does not depend
on how many powers are up.

Each power's identity is one hue and two radiance gains, in a single table read
by the power, by the body renderer and by the light pool alike — so a power
cannot be one colour close up and another at range. The gains are stated against
two measured numbers: lit dust sits near 5 in linear units, and the bloom bright
pass thresholds at 3.

1. **Solar Flare** — a crescent of ignited dust rises out of the sea and runs
   outward, ploughing a channel and throwing glowing berms. Body radiance 12: the
   hottest sustained thing on the ground, above the wake's own crest.
2. **Ion Stream** — a held stream tracking the hand and camera aim, drawing
   precessing figure-eights and scoring thin glowing lines into any dust it
   skims. It is a *record of where its tip has been* rather than a shape
   recomputed from the current aim, which is what gives it momentum: swing the
   camera and the tip goes, the body following a fraction of a second later.
   Released, it eats itself from behind over about three quarters of a second. Body
   radiance 6, deliberately restrained: it is the one power that is *held*, so it is
   the one thing here that can sit on screen for ten seconds, and a tether at
   detonation brightness stops being an event and becomes the exposure.
3. **Supernova** — a targeted detonation. A white-hot column bursts up out of the
   sea, blows a crater with a raised rim, collapses back down its own axis, and
   leaves four seconds of fallout lit from below. Body radiance 26, three stops
   over the bloom knee, cooling down the same warm ramp the dust's own discharge
   sits on.
4. **Star Crystal** — loose dust snaps into a lattice. Hexagonal prisms grown
   along a golden-angle spiral, alpha-blended *and* depth-writing, so you see the
   dust through the crystal but never one prism through another. Facet normals
   come from screen-space derivatives, so every facet is exactly flat and every
   edge exactly hard. The patch it grew from stays charged long after the prisms
   are gone.
5. **Gravity Well** — three helices of lifted dust winding around the player, with
   the airborne mass emitted along those same helices at their own tangential
   velocity. The only system here that writes a *negative* depression — a brush
   that takes a ring of the sea away is the same code path as one that puts it
   back, with a sign on it. Body radiance 4, the dimmest of the five: a well is a
   thing light falls into, so what is in the air is lifted mass rather than plasma
   and wells at about the brightness of the ground it tore up.

Refraction needs no scene copy and no second opaque pass: the sky LUT already
stores the dust sea's solved radiance below the horizon, so one lookup along the
refracted ray is a physically-derived estimate of what is behind the body in any
direction. Three lookups at three indices of refraction give the chromatic
dispersion, and absorption over the path length gives the tint.

Four pooled dynamic lights are declared per frame, and every one of them runs the
identical subsurface term the star runs — so a power lights the dust *through* a
berm crest rather than putting a bright patch on the near face of it. A light's
gain is an order of magnitude above the body it belongs to, and that is geometry
rather than preference: a light gain is measured at the emitter, falls off as the
inverse square, and is then multiplied by an albedo of 0.085. The dust, the suit,
the wake, the airborne grains, the plasma and the crystal all read the same pool
out of one include.

### The galaxy

There is no atmosphere, so there is no scattering integral. The sky is a fixed
analytic backdrop — a void that is genuinely black, a faint galactic band with
dust lanes, and auroral curtains — evaluated from a handful of noise calls and baked into a
512×256 equirectangular LUT, with a 64×32 copy read back on the CPU for
spherical-harmonic irradiance. Analytic rather than a captured HDRI for the same
reason the atmosphere it replaced was: with a model, the band's tilt and core
bearing are sliders that correctly drag the ambient tint and the horizon along
with them. Modelling the backdrop as scattering would have been actively wrong —
in vacuum the sky is not a function of the star at all, and tying the two
together would swing the whole galaxy every time the star moved.

The aurora is the one part shaped rather than merely coloured. Its noise is
sampled with the vertical axis of the sample point squashed to a quarter, so the
field varies quickly in azimuth and slowly in elevation and its features run as
vertical curtains; sampled isotropically the identical noise gives blobs, and
blobs read as nebulae, which is a completely different thing to look at. It is
thresholded hard so most of the sky stays empty — a curtain that covers
everything is fog — and its peak is held at output level 128 against a bloom
threshold it never reaches, because an aurora that glows is a light source and
this one is meant to be scenery.

The lower hemisphere of that LUT is not sky. It holds the dust sea's own solved
radiance, and the solve is a genuine iteration: bake, project to SH, work out what
the ground is now radiating, bake again. It converges in three passes, faster than
a bright ground would, because each round trip through the reflected term is
multiplied by 0.085 rather than 0.85 — and because the emissive term is a constant
that does not iterate at all.

Point stars are drawn in the skybox fragment shader only and never enter the bake:
at the 64×32 the SH readback runs at, a star is far smaller than a texel and what
the projection returns is not a star field but a randomly-tinted ambient that jumps
every time the star moves. They are laid out in cells on the six faces of a cube
rather than in lat-long UV, which is two lines longer and avoids a visible pinch of
crowded stars at the zenith — exactly where the camera looks when you drop into a
trough and pitch up out of it. One candidate star per cell, tested against a single
hash, with apparent magnitude cubed so the population is overwhelmingly faint with
a handful of bright ones. Each is drawn about two pixels across — small enough to
read as a point, large enough that the temporal resolve does not treat it as
sub-pixel noise.

The near star is a third of a degree across with limb darkening: smaller and harder
than the sun seen from Earth, because there is no air to soften its edge. What is
left of its aureole is not atmospheric — in vacuum a bright point source has no
halo in the scene, only in the instrument watching it, which is the same thing the
bloom pass downstream is modelling.

The far range of crystalline debris is a heightfield raymarched on the skybox — no
geometry, behind everything by construction, with analytic normals, ridges
occluding ridges, and a second short march toward the star for its own cast
shadows. It is lit by the dust field's own material logic and hazed by the same
nebula, so the two meet at one colour instead of two.

### Post-processing

A camera-space depth prepass (linear view depth carried as a varying, plus a
reflectivity mask) feeds the whole chain. Every pass stays attached and early-outs
in its own shader rather than being detached, because toggling a post-process off
reshuffles which texture every remaining pass renders into.

- **TAA** — Halton(2,3) jitter written straight into the projection and frozen for
  the frame, so the prepass and the beauty pass agree to the subpixel. Depth-based
  reprojection, a five-tap Catmull-Rom history fetch, and variance clipping whose
  box is widened to contain the current sample — which is what keeps the star field
  alive, since a bright point on black is otherwise clipped below the value the
  renderer just produced, every frame.
- **Bloom** — three levels, thresholded at 3.0 in linear scene radiance, before
  exposure. That number is the line between the dust's resting glow at 1 and the
  scene's actual sources: the visor, the suit trim, the wake, the thrown grains and
  the star. The mix is weighted toward the *tight* level, the opposite of what an
  atmosphere wants — the broad lobe of a glare pattern is forward scattering off
  aerosols and there are none out here, so what is left is the instrument's own
  point spread, whose energy sits in the core. Karis-averaged on the prefilter, so
  that a single grain at many times its neighbours' radiance cannot make the whole
  glow flicker as the glint field turns over. The point stars sit one to two orders
  below the threshold and never enter it at all, which is deliberate — a halo on
  every star would fog the void they are meant to sit in.
- **Volumetric light shafts** — integrating sky visibility out of the prepass along
  the ray to the star. A shaft needs a medium and vacuum is not one, so what these
  are is the star lighting the nebula the field is drifting through, with the dust
  swells cutting shadows through it. A nebula is thin and uniform along the ray
  rather than piled up near the ground, so the beams run further than an
  atmosphere's and come out proportionally far dimmer — the star's spectrum through
  a scattering albedo, which lands the root of a shaft at about 3.2 against dust lit
  to 5.
- **Depth of field** — deliberately slight, focal plane tracking the spring arm's
  own length, weighted by each tap's own circle of confusion. The far side is capped
  at a third of the near side's: a wide lens at a small aperture focused at six
  metres has infinity inside its depth of field already, and defocusing the sky
  would erase a star field drawn two pixels at a time.
- **Screen-space reflections** — on the mirrors only, gated on the prepass mask: the
  astronaut's gold faceplate, and what a Star Crystal leaves — the prisms and the
  glaze around them. One untinted pass serves both, because the Fresnel term
  confines it to grazing angles, where every material, metal and dielectric alike,
  climbs to a reflectance of one and loses its tint. The surface normal is
  reconstructed from the nearer of two depth taps on each axis rather than a
  one-sided difference, so a small curved faceplate with the helmet shell behind its
  rim does not build a normal out of the silhouette. A miss writes the source pixel
  back untouched rather than black: the ray has not discovered that the reflection is
  dark, only that it is the galaxy, which the material already put there.
- **AgX / ACES tonemapping**, contrast-adaptive sharpen, grain, vignette. AgX by
  default — the frame runs from empty sky at a thousandth of middle grey to a star
  disc three orders of magnitude above it, and a short shoulder clips the star, the
  wake and the band to the same white when every one of them is a different colour.
  Saturation is pushed back up harder than a daylight grade would want, because in
  this scene the chroma lives *in* the highlights.

---

## Performance

**Not re-profiled since the reskin.** The figures below were measured with WebGPU
timestamp queries at 2560×1440 on Chrome / Windows 11 / RTX 5070 Ti, with every
system running, on the snow build this project grew out of. The geometry, the pass
structure, the render-target budget and the draw count are unchanged, so they are
indicative rather than invented — but they are not a measurement of what is in this
repository now.

| | |
|---|---|
| GPU frame | **3.22 ms** |
| — base scene (clipmap, surface, 3 cascades, sky, character, displacement, prepass) | 1.64 ms |
| — post chain | ~1.1 ms |
| — far range | ~1.2 ms |
| — character (skeleton, cloth, nap, grains) | < 0.02 ms |
| Draw calls | 15–19 |
| Triangles | ~353,000 |
| Headroom against a 90 FPS budget | **7.9 ms** |

Two changes push in opposite directions and have not been weighed against each
other on hardware. Depth of field now takes its early-out over the whole sky
instead of running a sixteen-tap gather there, which on a frame that is mostly sky
is a real saving; the reflection pass reconstructs its normal from four depth taps
instead of two, on the handful of pixels that are mirrors.

Nothing allocates in the render loop. Every buffer is sized at construction, every
per-frame write goes into a pre-allocated typed array, and every material,
procedural texture and render pipeline is explicitly `isReady()`-gated and
exercised with real geometry behind the loading screen — so the first cast of a
power does not compile a pipeline mid-frame.

VRAM is roughly 350 MB: a 4096² height texture, two 2048² displacement targets,
three 2048² shadow cascades, two full-resolution half-float history buffers, and
the sky and detail LUTs.

---

## Running locally

```bash
npm install
npm run dev      # vite dev server on :5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

Node 20.19+ or 22.12+, which is what Vite 8 wants.

## Deploying

It is a static build with no server side, so any static host will do. `vercel.json`
declares the Vite preset, `npm run build`, `dist` as the output, and immutable
caching on the hashed assets with the entry document left revalidating.

The custom domain is not in this repository and cannot be — it lives in the
Vercel project's own settings. Add `starsurfer.nathantowianski.com` under
Settings → Domains, then add the CNAME record Vercel shows you at whoever serves
DNS for `nathantowianski.com` (host `starsurfer`, pointing at Vercel's target).
The certificate is issued automatically once the record resolves.

Nothing needs configuring beyond that: there are no environment variables, no API
routes, no redirects, and no `base` path — the app assumes it is served from the
root of its domain. Source maps ship with the build. That is deliberate rather
than an oversight: the whole project is MIT and readable anyway, and being able to
read a stack trace off a real phone is worth more here than the download it costs,
since a browser only fetches them with devtools open.

## On a phone

It runs. Whether it runs *well* depends on the phone, and the honest answer is
that this is a demanding scene being asked to fit somewhere it was not designed
for.

A coarse pointer switches the whole thing to a mobile tier before anything
allocates. The height field drops from 4096² to 2048², the auxiliary map and the
three shadow cascades halve, the grain map halves, the trail buffer halves, and
the render scale goes to 0.75 — together roughly 250 MB of GPU memory that a
shared-memory device does not have to find. Screen-space reflections and depth of
field are switched off, being the two passes whose cost is per-pixel and whose
contribution is least legible at arm's length.

Bloom, TAA and the tonemap all stay on, and that is not a matter of taste. Bloom
is how the wake's crest, the thrown grains and the galactic band read as bright
rather than merely pale; TAA is what stops a two-pixel star field aliasing into
a crawling mess, which a phone's pixel density makes worse rather than better.

Every one of those is a slider in the overlay, reachable from the ⚙ in the corner,
so a device with headroom can be pushed back up. The fixed render targets are the
exception — they are sized at construction and a reload is the only way to change
them.

## Layout

```
src/
  main.js            entry point and frame orchestration
  core/              settings, palette, input, camera rig, perf, loading, GPU helpers
  terrain/           heightfield, clipmap mesh, terrain state buffer
  render/            sky + IBL, shadow cascades, depth prepass
  character/         skeleton, procedural geometry, cloth solver, dust contact
  vfx/               pooled stardust grains, the star-surf wake
  spells/            the five powers, the shared plasma body, the light pool
  post/              the post-processing chain
  ui/                settings and performance overlay
  shaders/           all WGSL — lib/ holds the shared includes
```

`core/brand.js` is the one place the palette lives: near-black indigo void,
violet-magenta nebula, warm gold accent. Every material, LUT bake, particle system
and post pass reads its linear triples, and it carries the same colours as hex for
anything a human reads. Emissives are kept separate from reflectances there,
because they are the values that are *supposed* to exceed 1.0 — a hex code can only
describe an albedo, and clamping a radiance into [0,1] would flatten exactly the
parts the bloom pass exists to catch. The gains it lists are not free-floating:
they are stated against two measured numbers, lit dust at 5 and the bloom threshold
at 3, so reading one tells you whether the thing it belongs to glows.

Two identifiers are worth explaining rather than renaming. `sun` throughout the
code and the shaders means the one distant star — it is what every WGSL uniform
block already calls its single directional source. And a settings key beginning
`spell` is one of the five powers; the overlay labels them "Powers", and the key
names are read by a dozen files and appear in no user-visible string.

The word *snow* survives in a handful of comments, always as a comparison and
never as a description. The macro layer gives up its anisotropy specifically so
the field stops reading as wind-carved dunes; the albedo is held genuinely dark
because a pale diffuse ground reads as snow whatever hue it is tinted. Those
comments are the reasoning behind a number, which is what the comments in this
repository are for.

## Assets and licences

There are no third-party assets. Every texture, environment map and piece of
geometry in the running demo is generated at load time on the GPU: the sky is a
handful of noise calls, the dust grain and the landform are noise, the astronaut
is lofted from a table of numbers, and the suit's weave and the insulation fibres
are evaluated in the fragment shader.

Runtime dependencies are `@babylonjs/core` and `@babylonjs/materials`
(Apache-2.0). The only build dependency is Vite (MIT), which does not ship in the
output.

This project is released under the [MIT licence](LICENSE).
