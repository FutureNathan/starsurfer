# STARSURFER

An astronaut surfing the moon under a galaxy of stars. WebGPU, Babylon.js,
hand-written WGSL. Everything you see is generated on the GPU at load time — there
are no textures, no meshes, no HDRIs and no animation data in this repository.

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
| `Shift` | sprint on foot · **trick jump** on the board |
| **Right mouse (hold)** | star-surf — carve across the regolith and throw a luminous wake |
| `1` – `5` | the five powers (`2` is a held cast) |
| `Esc` | pause menu — frees the mouse, shows the controls |
| `F1` or `` ` `` | settings and performance overlay |

`Esc` is the player's menu, and it now *hosts* the instrument panel too.
Escape drops pointer lock (the browser does that part and no page may veto
it), the lock loss opens the menu, and the menu's presence pauses the
simulation — so alt-tab and focus loss pause the game through the identical
path, which is what anyone would want anyway. The menu is two tabs on one
opaque panel: **controls** — keycaps, the world's seed, a resume button, and
a made-by credit — and **settings & stats**, which adopts the F1 overlay's
element wholesale by reparenting it into the panel. F1 in-game still opens
the same overlay docked to the right edge for anyone tuning while riding;
the two routes share one DOM node, so they can never show different values.
A quiet `esc — pause · menu` label sits in the bottom corner while riding,
because a menu nobody knows about is a menu that does not exist.

The menu's third tab is **sound** — music and effects, each with a switch and
a volume, the Minecraft arrangement because it is the one everybody already
knows. The two halves are deliberately different technologies. The effects are
*synthesised live* in `core/audio.js`: the surf is filtered noise keyed to
speed, a footfall is seventy milliseconds of it fired on the frame the gait
actually plants a boot, and each power has its own few lines — a bandpass
sweep for the Flare, a sine dropping two octaves for the Supernova, a
four-layer impact for the asteroid whose rumble swells for exactly the
exported fall time and lands its boom with the rock. The Ion Stream, held,
is a quiet piece of score rather than a status hum: a low fifth breathing on
an eight-second swell, with a sparse pentatonic motif walking stepwise on a
glass tone above it — in the key the music leans on, so it reads as
accompaniment, and pleasant enough to leave on. No files, no licences, and
they can never go missing.

The music is *real tracks* in named playlists, Minecraft-style: one song,
minutes of vacuum, the next, shuffled without repeats, with the playlist
switchable on the sound tab. Three ambient pieces composed and rendered
offline for the project (**Drift**, **Low Gravity**, **Afterglow**, CC0) ride
alongside whatever the manifest lists. `public/music/README.md` is the
three-minute recipe for adding tracks; the player quietly skips anything
missing from the folder.

The controls are also on the loading screen, which is the one moment anybody is
going to read them — there is a captive audience there for as long as the
pipelines take and nothing else on screen. The list and the one-line hint under
the frame come from the same table in `core/loading.js`, and which of the two
lists you get is decided by the same coarse-pointer test that mounts the touch
controls.

On a touchscreen the on-screen controls appear instead, and nothing else changes —
they write into the same input struct the keyboard and mouse do.

| | |
|---|---|
| Drag anywhere | look |
| Thumbstick (bottom left) | **the throttle** — nudge to walk, most of the way to run, out to the ring to surf |
| Two-finger pinch | zoom |
| Five ringed buttons (bottom right) | the powers · **ION** is held |
| ⚙ (top right) | settings and performance overlay |

**The camera follows you.** Once the look input has been idle for a beat, the rig
takes the view back behind the rider's heading, at a rate that scales with speed
and eases in so it never yanks. That is a touch-only default and the split is the
point of it: a mouse aims the camera and the board at once, so a camera that
quietly re-aimed itself would be fighting the hand already steering it. A thumb
cannot — the stick and the look pad are different hands, and holding a heading
through a carve while also dragging the view round to see where the carve is going
is not something anyone manages on a phone. It is a toggle in the overlay either
way.

**There is no surf button**, and that is not just one fewer control to hit. A
button makes surfing a mode you are in or out of; a throttle makes speed something
you lean into, which is what the scene is about. It also frees the corner — the
one spot a thumb reaches without moving the hand — for the powers.

The stick sits at one fixed spot. It used to float, drawn wherever the thumb
landed in the lower-left quadrant, which is the better ergonomic on paper and
worse in practice for one reason: a stick with no fixed home has no *memory*.
Every re-grab starts a new frame of reference, so after a couple of lifts you no
longer know where centre is — and on a control whose whole job is a graduated
throttle, that matters more than not having to aim. Pinned, the ring is always on
screen in the same place, and half a second of use is enough to stop looking at it.

The gear change still has hysteresis, because a thumb resting on a threshold
shakes across it and the cost of a false crossing is the astronaut flickering
between a walk and a nineteen-metre-a-second carve. But the band is much narrower
than the floating stick needed: full deflection now means the thumb is genuinely
at the edge of the ring, which is a place it can be held, rather than "still
travelling outward", which pinned any moving thumb at the top of the range by
definition. Surf engages at 0.78 of travel and releases at 0.64.

Append `?touch=1` to force the controls on for a look at the layout from a
desktop, or `?touch=0` to force them off.

The overlay exposes every art parameter as a live slider — the star's bearing and
elevation, the galactic band's tilt and core bearing, the planet's bearing and
size, aurora strength, the nebula fill on the ground, displacement depth,
tonemap curve, exposure — plus a frame-time graph
with median / 95th / 1% low, draw calls, triangles and a per-system CPU
breakdown. Every system can be toggled off individually, and there are debug
views for surface normals, fine normals, depth, cascade coverage, the
displacement buffer and the footprint field.

---

## What it does

### The moon

A nested-ring geometry clipmap: 8 rings, 8.5 cm inner spacing, ~870 m radius,
333k triangles — **one static mesh, one draw call**. Vertices carry only
`(gridIndex, ringLevel)`; world placement, CDLOD morphing and displacement all
happen in the vertex shader, so there is no CPU rebuild and no per-frame upload.

The landform under it is isotropic at every scale, and that is the whole shape of
it. Anisotropy is a wind signature: stretch a noise layer along one bearing and
you get transverse ridges, which is what a dune sea or a snowfield looks like
because that is what wind does to one. There is no atmosphere here, so there is no
bearing. What carved this ground is impact, which arrives from every direction
equally and leaves circles.

So: broad rolling swells and hundred-metre highland massifs, with a **crater
field** cut into them on three jittered grids — basins 60–165 m across, craters
14–46 m, bowls down to 3.6 m. Each has a flat floor out to just over half its
radius, a raised rim standing on the radius itself, and the outer half of that
rim's falloff serving as the ejecta blanket. The rim matters more than the hole:
with the star at thirteen degrees, the shadow a crater throws inside itself and
the highlight on its far lip are a far stronger read than the depression is.
Radii are biased small, because a real size-frequency distribution is, and a
uniform draw gives a field of same-size holes that reads as a pattern. Between
them the three scales cover a little over half the ground, so nothing is flat and
almost nothing is a clean circle — every crater is sitting in the wreckage of
older ones. The fine layer on top is knobbly rather than streaked: metre-scale
rubble and half-metre secondary pitting.

The massifs' micro-relief is floored at an ~11 m wavelength, and the floor is a
contract with the character rather than a taste. Grounding reads a
half-resolution CPU mirror of the bake through a smoothing B-spline; the render
reads the full bake. On smooth ground the two agree to centimetres, but ridged
octaves at a 1.4 m wavelength with metres of amplitude are content the mirror
cannot represent at all — the drawn summit stood half a metre above the surface
the feet were planted on, and the astronaut waded through every peak. With the
finest octave held where both reconstructions carry it, the residual mismatch is
back under the dust-sink the figure already has.

The macro half bakes once into a 4096² R32F texture over a 2048 m field (0.5 m per
texel) plus a 2048² RGBA16F auxiliary of slopes, bedrock mask and exposure, and is
mirrored back to the CPU — so character grounding samples exactly the surface that
is drawn rather than a re-implementation of it. The crater field is part of that
bake and costs nothing at runtime. The fine half is evaluated live, with exact
analytic derivatives, and is never baked at all. (Every figure here is the desktop
tier; the mobile tier halves each of these — see [On a phone](#on-a-phone).)

**Every visit is a different stretch of this moon.** A world seed, drawn fresh
each load and pinned with `?seed=N` in the URL (the number is logged at boot
and shown in the pause menu), slides the bake's noise domain tens of
kilometres — different swells, different craters, different massifs — while
the material, physics and readback pipelines never know anything changed,
because the seed lives in the bake shader and nowhere else. And each world
carries one **landmark ring**: a great complex crater a few hundred metres
from spawn, standing wall, sunken floor, central peak — the profile every
large lunar crater shares. Every other feature repeats statistically; the ring
is singular per world, and that is its whole job. A map with a landmark is a
place you can be lost in; a map without one is a texture.

The albedo carries markings as well as relief: highland/mare provinces at the
625 m wavelength that give the real moon its face, and **ejecta rays** — lanes
of fresher, brighter fines thresholded hard so most ground carries none,
running in broken streaks rather than blobs. Both are what stops a crater
field reading as one grey plane with holes in it.

### Regolith shading

Almost nobody guesses how dark the moon is. It looks white because it is the only
thing in the sky and the eye has nothing to compare it against; a full moon's disc
reflects about as much as worn asphalt. Getting that right is most of the
difference between a moon and a snowfield, and it is very hard to unsee once the
mistake is made — a bright diffuse ground under a hard raking light reads as snow
whatever hue it is tinted.

Two terrains, mixed by a slow field about six hundred metres across: **highland
anorthosite at 0.128 / 0.118 / 0.107** and **mare basalt at 0.068 / 0.066 /
0.069**, roughly half as reflective and a touch bluer. That contrast is why the
moon has visible markings from a quarter of a million miles away, and at ground
level it is what stops a crater field reading as one flat grey plane with holes in
it. Bedrock shows on the massif faces too steep to hold anything, and it is
*brighter* than the regolith rather than darker — unweathered highland rock is the
most reflective thing there — so the mountains keep a pale edge against the sky
instead of falling to silhouette.

On top of that: multi-scale normals (baked macro slope, analytic rubble and
pitting, three tiled detail scales, triplanar on steep faces) over wrapped
diffuse, a back-scatter subsurface term, GGX specular, SH ambient with an
iteratively-solved ground bounce, and procedural view-dependent glints gated on
grazing angle — the moon really does glitter, a third of the Apollo soil by weight
being impact glass. Compression, displacement and charge are surface state
channels the material reads rather than separate materials: compacted regolith
goes *darker*, because crushing the fluffy top layer is exactly what destroys the
structure that makes it bright, which is why rover tracks are visible from orbit.
Freshly turned ground goes brighter, because space weathering only reaches the top
few millimetres and opening the surface exposes immature material underneath.

The ground carries a small amount of its own light, and it has to. One star at
thirteen degrees and a sky whose integrated irradiance is a rounding error beside
it means a shadow here is as black as the void above it — which is what a shadow
on the real moon is, and which would leave half of most frames with nothing in
them. So a neutral, cold nebula fill wells out of the low ground and up the shaded
flanks. The gradient runs *opposite* to N·L, which is why the relief still reads
where the star cannot reach it. Sunlit highland lands at output level 172 and a
shadowed crater floor at 38 — a four-and-a-half-stop split, brutal by the
standards of a scene with an atmosphere and about right for one without.

Shadows are three hand-rolled cascades with world-space PCSS — blocker search,
penumbra estimate, rotated Poisson filter — texel-snapped in world space and
stabilised against a rotation-invariant bounding sphere. One distant star means
one hard shadow, and with no sky to soften the terminator that shadow is the
strongest single form cue in the frame — it is what makes a crater a crater rather
than a grey ring. Babylon's own cascade generator can't be
used here: the terrain has no CPU geometry matching what is drawn, so every
caster registers the vertex program it is actually rendered with.

### Displacement

A persistent, additive terrain state buffer: two 2048² RGBA16F targets covering
80 m (3.9 cm texels), ping-ponged by a single full-screen pass per frame that
scrolls, relaxes and splats in one dispatch. Addressing is toroidal — a texel's
UV is `fract(worldXZ / size)` — so the window follows the player without ever
copying the buffer, and newly exposed texels are detected and zeroed by the same
pass.

Channels are depression depth, displaced mass, compression and charge. That second
channel is what separates a trail with raised berms from a flat footprint decal;
the fourth is what a power and the board's own rail leave behind, and it drives
both a dark impact-glass albedo and a gold emission, so a scar stays visible from
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

**There is no cloth.** There was — a Verlet solver over tubes of particles,
feeding a Catmull-Rom surface reconstruction in the vertex shader — and it was
removed rather than retuned, because the thing it was simulating does not exist. A
pressure suit is a laminate held between hard bearings; every panel authored
against it read as loose fabric no matter how hard the pins were driven, and a
figure in loose fabric is not an astronaut. What the suit needed instead was bulk
and a metal band at every joint, and both of those are lofted geometry: the arms
took over the sleeves' silhouette outright, which is why their radii look large
for the limbs inside them. A suit arm is far fatter than an arm. What survives of
the soft goods is the frayed nap of multi-layer insulation at the neck seam and
the glove cuffs — a partial torus emitted ten times per band and alpha-tested
against a hashed fibre field, 14 mm long, which is why ten shells is already past
visible banding — and that is bone-bound, not simulated.

Feet plant. A distance-driven stance/swing machine writes a foot's world position
exactly once, on touchdown, and holds it absolutely fixed while two-bone IK
reaches for it — a planted foot cannot slide because nothing in the code is able
to move it. Gait phase advances with ground travelled, so stride length and
ground speed are the same number by construction.

On the board the stance is a real one. A surfer does not face the way the board is
pointing: both feet stand on the stringer, one behind the other, and the body is
turned across the deck. Regular-footed, so the left foot is forward — 26 cm ahead
of the waist against 30 behind, a 56 cm stance on a deck that runs 94 cm forward
of the bone. The pelvis opens 66° toward the toe-side rail and the shoulders about
eight degrees further, each boot takes its own angle across the deck (50° at the
front, 85° at the back, which is the asymmetry every stance has — the front foot
steers and the back foot drives), and the neck takes 80% of the turn back so the
visor keeps looking down the line. The stance is applied about the body's own
*up* axis after pitch and roll rather than being folded into the yaw, so leaning
into a carve still tips the rider over the inside rail instead of toward the nose.

One small 48×4 texture carries everything to the GPU: four rows of bone matrices,
one column per bone. One upload per frame, no allocation.

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
being driven. The wall is thrown regolith and wells the warm pale grey of it at a
linear radiance of 7.9 — airborne dust is lit from every side rather than only
from above, scatters strongly forward, and has just been broken open, so it is
legitimately far brighter than the ground it came out of. The lip — the hottest,
freshest mass — reaches gold at 13, which clears both sunlit ground at 5.5 and the
bloom threshold at 6.5, so the crest is the brightest and by a long way the warmest
point on the whole structure. On a straight run the crest sits at 3, well under
the bloom pass's reach, and does not glow at all.

The slope term had gravity backwards for a while, and the fix is worth
recording because the regression test *printed* the bug as a pass. The assist
read the surface normal and negated its dot with the facing — and the normal
leans away from the rise, so the negation put the boost on the uphill face and
the brake on the downhill one. The board died descending into every crater
bowl and rocketed up the far wall, which reached the bug tracker as "he gets
caught sometimes"; the test asserted no-reverse and printed top speed without
judging it, so `19.4 m/s straight up a 45-degree wall` sat in the output as a
pass for days. The grade is now sampled as a height difference across a board
length along the travel direction (a point normal reads 3.6 m bowls' rims at
full strength; the hull bridges them), a crest costs a third at speed what it
costs from a standstill (momentum carries through short rises), and thrust
is floored just above zero with the surf held — so the board brakes, carves
and grinds but never parks. The test now asserts all of it in both
directions: downhill must reach full speed, crater bowls must be crossed
without the speed ever dipping, and a board pointed up a wall must creep, not
climb.

The board will not travel tail-first. That reads as a styling rule and is really a
physics one, and it was a bug for a while: the carve scrub used to be subtracted
straight out of the thrust, which quietly turned a brake into a reverse gear. At a
full come-about the scrub is 16 against a thrust of 11, so the sum went to -21 — a
force pointing out of the tail — and since the lateral grip only removes
*sideways* velocity, nothing took the resulting backwards component away again.
Alignment then sat at -1, which held the scrub at maximum, which held the thrust
negative: a stable equilibrium, riding backwards at nineteen metres a second with
the astronaut facing the other way. It needed a slope to trigger, and the ground
now has a great many more of those. The scrub is applied against the velocity
where it belongs, thrust is clamped at zero, and any reverse component is removed
outright.

Two grain populations come off the same spine — a dense slow curtain hugging the
crest, and ballistic grains flung clear that burn at fourteen times starlight
white, the brightest emissive in the palette — emitted at *fractional* positions
along it, plus screen-space speed streaks and camera shake on a loaded edge. The
streaks are the same grains seen closer: a screen-space strand is one of them
smeared along its own path, stated at the radiance that smear leaves it with.
The whole streak system reads the prepass and leaves background pixels alone:
streaks are motion, and the stars are not moving — a star field smeared into
radial lines is a warp-jump effect on a scene whose premise is standing still
under a fixed sky. The ground blurs with speed; the sky holds.

### The five powers

One plasma material, one mesh, one draw, twelve strands of 64 columns. All five
move a coherent body of ignited dust and are structurally the same object: a
swept surface along a spine, with a radius, a parallel-transported frame and an
ignition-front channel — the same construction as the surf wake. A strand that is
not in use is switched off by zeroing its rows, so the draw count does not depend
on how many powers are up.

Each power's identity is one hue and two radiance gains, in a single table read
by the power, by the body renderer and by the light pool alike — so a power
cannot be one colour close up and another at range. The gains are stated against
two measured numbers: sunlit ground sits near 5.5 in linear units, and the bloom
bright pass thresholds at 6.5 — above everything that merely *is*, so only events
glow.

1. **Solar Flare** — a crescent of ignited dust rises out of the ground and runs
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
   regolith, blows a crater with a raised rim — a fresh one, on a surface made of
   them — collapses back down its own axis, and leaves four seconds of fallout lit
   from below. Body radiance 26, two stops over the bloom knee, cooling down the
   same warm ramp the ground's own discharge sits on.
4. **Asteroid** — a rock comes in from orbit and hits the ground well ahead of
   you. Three hundred metres of entry over two and a half seconds, on a
   twenty-three degree path that crosses the frame diagonally; then a crater
   twice the Supernova's, an ejecta curtain, and the hardest camera shake in the
   project. Press it again and another one comes; **up to five can be falling at
   once**, and the more of them there are the wider they scatter.

   It is the only power you *watch arrive*. Everything else here is instantaneous
   — press a key and a thing is already happening — and two and a half seconds of
   anticipation turns the impact from something that occurred into something you
   saw coming.

   Which only works if it is *in the picture*, and the first version was not. It
   entered behind the rider and fell steeply, sixty-seven degrees above the
   horizon; the camera sits 6.1 m back and 2.9 m up, pitched ten degrees down,
   with a 58-degree vertical field, so the top edge of the frame is nineteen and a
   half degrees up. The asteroid spent the first ninety-three per cent of its fall
   outside the frame and appeared for the last tenth of a second — 0.11 s of a
   1.5 s cast.

   The geometry is unforgiving. An object falling to a point in front of you is at
   its highest apparent elevation the moment it enters, because the height shrinks
   faster than the distance does, so there is one condition and it decides the
   whole trajectory: the horizontal run has to be about two and three quarter
   times the entry height, and the entry has to be *beyond* the impact rather than
   behind it. At the numbers above the worst of forty randomised casts is on
   screen for **100% of the fall**, at rest and at full surf speed.

   It is also the one power that is not aimed at whatever the crosshair is over,
   and it cannot be. It takes 2.6 s to arrive and the rider does 19.5 m/s, so a
   target placed under the crosshair twenty metres out is somewhere the player has
   already gone past by the time the rock reaches it. Instead the impact is put a
   fixed 38 m along the aim bearing from where the rider *will be*: their velocity
   times the exact fall time, both read from the same two exported constants so
   they cannot drift. Standing still that is 38 m ahead; flat out it is 89 m ahead
   at the press and 38 m ahead when it lands.

   What falls is a rock, and that took three versions to admit. The first two
   drew an entry burn — a glowing head, an ablation trail, sputtering fragments
   — and both read on screen as an orange blob, because they were modelling the
   wrong planet: ablation is what an atmosphere does to a falling rock, and
   there is no atmosphere here. Nothing burns on the way down. The falling body
   is a grey tumbling lump, four metres long, its silhouette dented by two slow
   sine lobes tied to the tumble so it turns over as it comes, held at a flat
   radiance of 5 — mid-grey regolith in full sunlight, deliberately *under* the
   bloom knee. It does not glow; it is simply a bright object against a black
   sky, which is how a real object in vacuum is seen, and its visibility comes
   from contrast and motion rather than fire. The ignition-front channel stays
   at zero the whole way down.

   The ember orange this power owns appears only where the physics puts the
   energy: at the ground. For a third of a second after contact the strand the
   rock just vacated becomes the impact flash — a squat burst that pops, whites
   at gain 25, and is embers before half a second is out, the way real lunar
   impacts photographed from Earth genuinely flash. An earlier pass drew a
   nine-metre dome of vapour boiling for most of a second here; the review named
   it precisely — a glowing blob — and it is gone. The lasting event is the
   crater.

   What it leaves is molten. The crater floor is the only thing that writes the
   top of the charge channel, and up there the ground material adds an ember-hued
   emission well over the bloom knee — the floor at the moment of landing is
   made of the same shocked rock the flash just was. The cooling needs no clock
   of its own: the terrain sim decays a hot channel on an 18-second constant
   (radiative cooling goes as the fourth power of temperature, so molten rock
   must not linger the way glass does), and as the value walks down through the
   band the same pixel goes white-orange, is a dim ember inside ten seconds,
   and fades on as a dark vitrified scar. The surf rail and the ion stream's
   scored lines sit below the band's toe and keep their slow tail.

   The impact is built to be seen from ninety metres, because that is where it
   happens. A four-metre crater and centimetre grains are a handful of pixels at
   that range, and half the time a swell is in front of them — what carries is
   radiance. The flash spikes two stops over the bloom knee, so it blooms from
   any distance, and the ground answers with a 24 m pool of light sweeping out
   and dying back, which places the impact even when the crater itself is
   behind a crest.

   Its ejecta obeys vacuum. Every grain is launched with a drag coefficient of
   zero, so it flies a clean parabola and lands — no hang, no settling curtain, no
   billow. That absence is more of the read than any amount of hanging dust would
   be, and it costs one argument. The curtain reaches about 28 m and peaks 14 m
   up; ninety-three per cent of it touches down inside its own lifetime, which is
   the number that decides the launch speeds.

   A storm shares out two budgets, harmonically, so the first rock is unaffected
   and five together are worth about 2.7 of one. The spray pool is a fixed ring of
   5,120 and `emit` drops silently once it is full, so five impacts at a lone
   rock's count would hold 3,200 grains at once and the thing that visibly broke
   would not be the asteroid — it would be the *wake*, thinning out for a second
   and a half with no obvious cause. Shared, the peak is 2,646, a little over half
   the pool. Camera trauma is shared on the same curve for the same reason: it
   accumulates and clamps at one, so five undivided impacts pin the shake at
   maximum and the storm becomes unwatchable.

   It replaced *Star Crystal*, which grew a lattice of violet prisms out of the
   ground. That power was built for a sea of cosmic dust and did not survive the
   ground becoming rock — a crystal formation on a cratered regolith plain reads
   as decoration rather than as something that happened to the place. Its
   renderer, its four shaders and its depth-prepass caster went with it.
5. **Gravity Well** — three helices of lifted dust winding around the player, with
   the airborne mass emitted along those same helices at their own tangential
   velocity. The only system here that writes a *negative* depression — a brush
   that takes a ring of the ground away is the same code path as one that puts it
   back, with a sign on it. Body radiance 4, the dimmest of the five: a well is a
   thing light falls into, so what is in the air is lifted mass rather than plasma
   and wells at about the brightness of the ground it tore up.

Refraction needs no scene copy and no second opaque pass: the sky LUT already
stores the ground's solved radiance below the horizon, so one lookup along the
refracted ray is a physically-derived estimate of what is behind the body in any
direction. Three lookups at three indices of refraction give the chromatic
dispersion, and absorption over the path length gives the tint.

Four pooled dynamic lights are declared per frame, and every one of them runs the
identical subsurface term the star runs — so a power lights the ground *through* a
berm crest rather than putting a bright patch on the near face of it. A light's
gain is an order of magnitude above the body it belongs to, and that is geometry
rather than preference: a light gain is measured at the emitter, falls off as the
inverse square, and is then multiplied by an albedo of 0.116. The ground, the
suit, the wake, the airborne grains and the plasma all read the same pool out of
one include.

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

It also now *defaults to nearly off*, with the band at a third of its old
strength. At the LUT's resolution a broad low-frequency glow reads as smear
rather than curtain, and the screenshot review called it exactly that. The
sky's resting state is dark — stars, a faint band, one planet — and the sliders
still run to two for anyone who wants the weather back.

The planets are the bright things that darkness bought — four of them now. The
hero is an analytic teal gas giant shaded in the skybox fragment shader — banded
latitudes warped by noise, a soft terminator lit from the scene's own star
bearing, limb darkening, a thin atmospheric rim — forty degrees across,
sitting high off the galactic band: the looming-world read, and *dimmer* than
it was when it was small, because a bigger disc at the same radiance reads
nearer and this one is meant to read enormous and far. Because every part of
it keys off the sphere's own normal rather than a texture, growing it costs
nothing in resolution: a third noise octave shears the band edges, threads
bright and dark filaments through the shear zones, and works one pale storm
oval into the banding, and a fourth, still finer octave puts texture inside
features that would otherwise be tens of pixels wide — detail that only
resolves on a disc this large, which is what keeps it looking drawn at full
resolution rather than scaled up. Its limb is anti-aliased over its last
percent and a half, and a faint self-lit inner term — strongest at the centre
of the disc, independent of the star — leaves the night side a dim luminous
crescent instead of a bite out of the star field. That is the "glowing from
within" read, done as painted shading: the lit face stays under the bloom
knee, so the glow is in the world and never in the lens.

Three companions hang off the hero's bearing at fixed offsets, so the one
slider swings the whole family and no setting can park one world behind
another: a small amber world a third of the sky round and high, a dimmer
violet one the other way low near the band, and a Mars — rust and
butterscotch, its band frequency dropped so low the stripes read as albedo
provinces rather than weather — sitting at eight degrees, where the tallest
ridge silhouettes genuinely clip it: a world that rises from behind the
mountains is in the scene, not printed on it. They share the hero's shader
with the fine octaves off — a two-degree disc has no pixels to show them. The
far range occludes all four like everything else in the sky, and they are
gated out of the star's aureole and the point-star field, so stars do not
twinkle through them.

The lower hemisphere of that LUT is not sky. It holds the ground's own solved
radiance, and the solve is a genuine iteration: bake, project to SH, work out what
the ground is now radiating, bake again. It converges in three passes, faster than
a bright ground would, because each round trip through the reflected term is
multiplied by 0.116 rather than 0.85 — and because the fill term is a constant that
does not iterate at all.

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
sub-pixel noise. Most run a quiet spectral ramp from blue-white to warm amber,
and about one in seven is genuinely coloured — sapphire, ember, teal or rose,
at full saturation, because a two-pixel point has no area to carry a subtle
tint: by the time TAA and the display have had it, "slightly blue" is white.

The field is also half as dense as it was, and its top two per cent draw at
roughly twice the diameter, brighter, and always in one of the saturated
classes. Both moves serve the same read: a sparser field with a few
unmistakable beacons in it has *depth* — a couple of obviously nearer suns
against a background of far ones — where uniform coverage reads as wallpaper.

The near star is a third of a degree across with limb darkening: smaller and harder
than the sun seen from Earth, because there is no air to soften its edge. Its
aureole is not atmospheric — in vacuum a bright point source has no halo in the
scene, only in the instrument watching it, which is the same thing the bloom pass
downstream is modelling — so it is deliberately tiny: a one-degree lobe hugging the
disc and a four-degree haze a third of a linear unit tall that never blooms at
all — both trimmed another quarter in the crisp-sky pass, since with the band
dimmed and the aurora off the haze was the widest soft thing left in the frame.

Getting that number wrong is worth recording, because it took three passes to find
and none of the first two were looking in the right place. The thing making the
sky near the star unbearably bright was not the star. It was the shaft pass: over
clear sky every sample along every ray is visible, so its integral is flat and what
it draws is not shafts but a *disc* of light as wide as its radial weight allows.
At the old settings that disc peaked at 5.9 linear and was still at 2.9 twenty-five
degrees out — the sky within half a screen of the star sat at output 150–190
against ground lit to 172. No amount of retuning the star's own glow could have
fixed that, because the star's own glow was not doing it.

The far range is a heightfield raymarched on the skybox — no geometry, behind
everything by construction, with analytic normals, ridges occluding ridges, and a
second short march toward the star for its own cast shadows. It is lit by the
ground's own material logic and hazed by the same nebula, so the two meet at one
colour instead of two. It also occludes: the star's disc, its analytic glow and
the point-star field are all gated off a range hit, so stars end at the
silhouette — a summit with stars twinkling on its face is the painted-backdrop
tell in the other direction — while the bloom pass still spills a half-hidden
star's glare over the edge, which is where glare actually lives.

The march window is set by the tallest thing the player can stand on, and the
moon rework moved both of its ends. The near massifs' tops sliced flat against
the old 13° ceiling; and from a hundred-metre summit the clipmap's far edge sits
at -10°, where the old -3° floor left a band of raw below-horizon LUT — a flat
pale smear with the range floating above it. The window now runs 18° down, with
a floor that adapts to eye height, and the march starts at 820 m rather than
five and a half kilometres out.

That last number is half the fix for the mountains floating, which survived a
first pass because the real cause was never the window. Between the clipmap's
870 m edge and the massifs' 5.5 km start line there was genuinely *nothing* —
the range's seven-kilometre bowl was dead flat — so from a summit the eye
crossed real terrain, then a level fully-hazed band, then mountains, and the
level band read as the range hovering over a gap. The bowl now carries a
mid-field fill: two octaves of rolling ground, a few metres high and biased
low so it never competes with the clipmap in front of it, continuous under the
massifs.

The other half — the half that made the *third* floating-mountains report,
after the fill was already in — was the haze itself. The scene's fog was a
hundred times thicker than air, hugging the ground on a 22-metre scale height;
from a summit, everything past a kilometre and a half sat at 60–97%
extinction, so the fill that was supposed to close the gap was being painted
over with featureless pale inscatter — a mid-field that existed and could not
be seen, with the LUT's texel rows striping through the wash. The density is
now a fifth of what it was, with the extinction curve relaxed to match. An
airless horizon is crisp to the last ridge — Apollo photographs are the
reference — and now that the ground stays ground all the way out, the eye
crosses swells to the massifs' feet and the range stands on them.

### Post-processing

A camera-space depth prepass (linear view depth carried as a varying, plus a
reflectivity mask) feeds the whole chain. Every pass stays attached and early-outs
in its own shader rather than being detached, because toggling a post-process off
reshuffles which texture every remaining pass renders into.

- **TAA** — Halton(2,3) jitter written straight into the projection and frozen for
  the frame, so the prepass and the beauty pass agree to the subpixel. The shadow
  filter's per-pixel rotation advances each frame specifically to feed this pass:
  a static hash is signal, not noise — the resolve faithfully converged to the
  hash itself, and since interleaved gradient noise is constant along
  near-vertical diagonals, every penumbra carried faint crawling lines. Animated,
  the resolve integrates sixty-four rotations and a penumbra comes out smooth.
  Depth-based reprojection, a five-tap Catmull-Rom history fetch, and variance clipping whose
  box is widened to contain the current sample — which is what keeps the star field
  alive, since a bright point on black is otherwise clipped below the value the
  renderer just produced, every frame.
- **Bloom** — three levels, thresholded at 6.5 in linear scene radiance, before
  exposure. That number was 3.0, set when the ground was a dim sea of cosmic dust
  resting at 0.4 — and the moon rework quietly killed that premise, because sunlit
  regolith sits at 5.5 and the suit's lit shell above 20, so the *entire daylit
  frame* was feeding the bright pass. That is the halo and the boxy glow around
  the spacesuit, and the smear across the sky, that the screenshot review
  objected to. At 6.5 the pass takes events only: the wake's lip, the thrown
  grains, the power bodies, the impact flash, the molten crater floors and the
  star. Sunlit ground, the suit and the visor no longer bloom at all. The mix is
  weighted toward the *tight* level, the opposite of what an
  atmosphere wants — the broad lobe of a glare pattern is forward scattering off
  aerosols and there are none out here, so what is left is the instrument's own
  point spread, whose energy sits in the core. Karis-averaged on the prefilter, so
  that a single grain at many times its neighbours' radiance cannot make the whole
  glow flicker as the glint field turns over. The point stars and the planet sit
  below the threshold and never enter it at all, which is deliberate — a halo on
  every star would fog the void they are meant to sit in.
- **Volumetric light shafts** — integrating sky visibility out of the prepass along
  the ray to the star. A shaft needs a medium and vacuum is not one, so what these
  are is the star lighting the nebula the field is drifting through, with the dust
  crater rims cutting shadows through it. A nebula is thin and uniform along the ray
  rather than piled up near the ground, so the beams run further than an
  atmosphere's and come out proportionally far dimmer — the star's spectrum through
  a scattering albedo of 2%, which lands the root of a shaft at about 1.4 against
  ground lit to 5.5. Reaching 25° off the star rather than 80% of the frame height,
  for the reason under [The galaxy](#the-galaxy).
- **Depth of field** — deliberately slight, focal plane tracking the spring arm's
  own length, weighted by each tap's own circle of confusion. The far side is capped
  at a third of the near side's: a wide lens at a small aperture focused at six
  metres has infinity inside its depth of field already, and defocusing the sky
  would erase a star field drawn two pixels at a time.
- **Screen-space reflections** — on the mirrors only, gated on the prepass mask: the
  astronaut's gold faceplate, and the impact glass a power or the board's own rail
  fuses into the ground. One untinted pass serves both, because the Fresnel term
  confines it to grazing angles, where every material, metal and dielectric alike,
  climbs to a reflectance of one and loses its tint. The surface normal is
  reconstructed from the nearer of two depth taps on each axis rather than a
  one-sided difference, so a small curved faceplate with the helmet shell behind its
  rim does not build a normal out of the silhouette. A miss writes the source pixel
  back untouched rather than black: the ray has not discovered that the reflection is
  dark, only that it is the galaxy, which the material already put there.

  There used to be a third mirror, the crystal prisms, and they are the reason the
  normal reconstruction is two-sided: a prism facet is flat by construction so a
  one-sided difference was enough, and the faceplate is a curved dome with the
  helmet right behind its rim, where it is not.
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

Four things have moved since in ways worth naming. The cloth solver, its render
mesh and its three pipelines are gone, which removes a draw call, a shadow caster,
a prepass caster and a per-frame CPU solve. The crystal renderer went the same way
with the power that used it — another draw call, another prepass caster, and four
shaders that no longer compile at load. The crater field adds twenty-seven
hashed cell tests per sample to the height bake, which is a one-off load cost paid
behind the loading screen and nothing at all per frame. And the far range's
once-empty near bowl now carries a mid-field fill — two gradient-noise
evaluations per march sample inside seven kilometres, on a march that already
breaks out early above its own ceiling; the planet is a handful of ALU in the
same skybox pass and the sky window got *cheaper*, since the march now starts
closer and quits sooner.

| | |
|---|---|
| GPU frame | **3.22 ms** |
| — base scene (clipmap, surface, 3 cascades, sky, character, displacement, prepass) | 1.64 ms |
| — post chain | ~1.1 ms |
| — far range | ~1.2 ms |
| — character (skeleton, pose solve, nap, grains) | < 0.02 ms |
| Draw calls | 13–17 |
| Triangles | ~382,000 |
| Headroom against a 90 FPS budget | **7.9 ms** |

The plasma body's strand pool went from eight to twelve to hold an asteroid storm
alongside every other power. That is a permanent cost and a small one: the lattice
is static, so twelve strands' worth of vertices are shaded every frame whether
anything is cast or not — 50,688 against 33,792 — but an unused strand has a zero
radius, which collapses all of its triangles to a point, and a degenerate triangle
is discarded before it reaches a fragment. What the four extra buy is 17,000
vertex invocations, not 34,000 triangles of shading.

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
  character/         skeleton, procedural geometry, locomotion, ground contact
  vfx/               pooled stardust grains, the star-surf wake
  spells/            the five powers, the shared plasma body, the light pool
  post/              the post-processing chain
  ui/                settings and performance overlay
  shaders/           all WGSL — lib/ holds the shared includes
```

`core/brand.js` is the one place the palette lives: near-black indigo void,
violet-magenta nebula, warm gold accent, and the three greys the ground is made
of. Every material, LUT bake, particle system and post pass reads its linear
triples, and it carries the same colours as hex for anything a human reads.
Emissives are kept separate from reflectances there, because they are the values
that are *supposed* to exceed 1.0 — a hex code can only describe an albedo, and
clamping a radiance into [0,1] would flatten exactly the parts the bloom pass
exists to catch. The gains it lists are not free-floating: they are stated against
two measured numbers, sunlit ground at 5.5 and the bloom threshold at 6.5, so
reading one tells you whether the thing it belongs to glows.

The regolith entries are a different kind of entry from the rest. Everything else
in that file is a design decision; those are measurements, and they are in there
because the ground is most of the frame and the one thing that must not be
redesigned by accident. Both the surface material and the bounce solve derive from
the same two, so they cannot disagree — a bounce that disagrees with the surface it
is bouncing off is invisible right up until the horizon splits in two.

Two identifiers are worth explaining rather than renaming. `sun` throughout the
code and the shaders means the one distant star — it is what every WGSL uniform
block already calls its single directional source. And a settings key beginning
`spell` is one of the five powers; the overlay labels them "Powers", and the key
names are read by a dozen files and appear in no user-visible string.

The word *snow* survives in a handful of comments, always as a comparison and
never as a description. Both noise layers give up their anisotropy specifically so
the ground stops reading as wind-carved; the albedo is held genuinely dark because
a pale diffuse ground reads as snow whatever hue it is tinted. Those comments are
the reasoning behind a number, which is what the comments in this repository are
for. The same goes for `dust` in a few identifiers — `dustGlow`, `dustEmissive`,
`dust.fragment.wgsl` — which mean the regolith. Renaming them would touch a dozen
files and change nothing a user can see.

## Assets and licences

There are no third-party assets in the repository. Every texture, environment
map and piece of geometry in the running demo is generated at load time on the
GPU: the sky is a handful of noise calls, the grain map and the landform are
noise, the crater field is three grids of hashes, the astronaut is lofted from
a table of numbers, and the suit's weave and the insulation fibres are
evaluated in the fragment shader. Sound effects are synthesised live in
WebAudio, and the three background-music tracks were composed and rendered
offline *for* the project (see `public/music/README.md`) and are CC0 like the
rest of its own work — swap them for anything you prefer without touching
code. The
favicon — a white star on black, nothing else — is a hand-written SVG in
`public/`, served with a `?v=` bump because browsers hold favicons far longer
than any other asset.

Runtime dependencies are `@babylonjs/core` and `@babylonjs/materials`
(Apache-2.0). The only build dependency is Vite (MIT), which does not ship in the
output.

This project is released under the [MIT licence](LICENSE).
