#include<starNoise>
#include<starAtmosphere>
#include<starShading>
#include<starRidge>

varying vDir: vec3f;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform sunDir: vec3f;
uniform sunColor: vec3f;
uniform sunIntensity: f32;
uniform time: f32;
/// Occupancy and brightness of the point-star field.
uniform starDensity: f32;
uniform starBrightness: f32;
uniform cameraPosition: vec3f;
/// Direct starlight reaching the ground, on the same scale the LUT stores
/// radiance in — so the range is lit by the identical number the dust is.
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;
/// Peak height of the far range, metres. Zero switches it off entirely.
uniform ridgeAmp: f32;
/// The ground's own emission. The range is covered in the same regolith and has
/// to glow by the same amount, or it draws as a black cut-out in front of the
/// galaxy while the ground in front of it shines.
uniform dustEmission: vec3f;

/// The companion world. Direction to its centre, its rotation axis (unit, tips
/// the banding), its angular radius in radians, and the radiance scale on its
/// lit face. Glow at zero removes it entirely.
uniform planetDir: vec3f;
uniform planetAxis: vec3f;
uniform planetSize: f32;
uniform planetGlow: f32;
uniform planet2Dir: vec3f;
uniform planet2Axis: vec3f;
uniform planet2Size: f32;
uniform planet3Dir: vec3f;
uniform planet3Axis: vec3f;
uniform planet3Size: f32;
uniform planet4Dir: vec3f;
uniform planet4Axis: vec3f;
uniform planet4Size: f32;
uniform planet5Dir: vec3f;
uniform planet5Axis: vec3f;
uniform planet5Size: f32;

// The field's own aerial perspective, so the range is hazed by the same nebula
// the dust in front of it is. See `shadeRidge`.
uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

/// Shade a point on the far range — the highland wall on the horizon, drawn on
/// the skybox rather than as geometry.
///
/// Deliberately the *ground's* material logic, not a separate one: the same
/// wrapped diffuse, the same SH ambient, the same regolith albedo, the same
/// emission. A distant massif rendered with its own ad-hoc lighting is the
/// classic way a matte painting announces itself — it does not sit in the same
/// light as the ground in front of it.
fn shadeRidge(hit: RidgeHit, dir: vec3f) -> vec3f {
    let N = hit.normal;
    let L = uniforms.sunDir;

    // Regolith on the shallow faces, bare rock on the ones too steep to hold it.
    // Nothing sweeps this range clear, so there is no line to speak of; the
    // exposed rock is here for the *break* it gives the silhouette.
    //
    // The rock is the brighter of the two, which is the way round it is on the
    // moon: fresh highland anorthosite is the most reflective thing there, and
    // four billion years of space weathering darkens whatever settles on top of
    // it. So the range keeps a pale edge against the sky instead of falling to
    // silhouette — which is the whole reason it is worth drawing at all at this
    // distance. Both numbers track `brand.js`: regolith is `LIN.regolith` and the
    // rock the same value the near field's massifs carry.
    // The boundary between fines and bare rock is *ragged*: dithered by
    // noise before the threshold, because a clean smoothstep of slope draws
    // contour lines around every peak — the terraced, dipped-in-paint look.
    let rag = noise2(hit.pos * 0.031) * 0.17;
    let steep = 1.0 - N.y + rag;
    let dustMask = clamp(1.0 - smoothstep(0.46, 0.80, steep), 0.0, 1.0);

    let rock  = vec3f(0.140, 0.143, 0.148);
    let fines = vec3f(0.117, 0.119, 0.127);
    var albedo = mix(rock, fines, dustMask);

    // Texture, and this is the second attempt at it. The first was two
    // smooth low-frequency octaves, which read from the field as pale
    // *stains* — smooth blobs are exactly what noise looks like when its
    // features are bigger than the thing they are meant to portray. What a
    // lunar massif face actually carries is craters: they are the texture,
    // at every scale, on every photograph. So: a fine granular pair for the
    // fines themselves, then a crater dapple — a thresholded field for the
    // bowls, darkened, with the *far* (sun-side) rim of each bowl caught by
    // sampling the same field a step toward the star and lighting where it
    // rises. Reads as pocked ground from any distance, for three noise
    // fetches.
    let g1 = noise2(hit.pos * 0.020) * 0.5 + 0.5;
    let g2 = noise2(hit.pos * 0.110 + vec2f(9.1, 3.3)) * 0.5 + 0.5;
    albedo *= 0.84 + 0.20 * g1 + 0.10 * (g2 - 0.5);

    let sunFlat = normalize(vec2f(L.x, L.z) + vec2f(1e-5, 0.0));
    let cq = hit.pos * 0.014 + vec2f(4.7, 1.9);
    let cDap = noise2(cq);
    let cUp = noise2(cq + sunFlat * 0.9);
    let bowl = smoothstep(0.26, 0.52, cDap);
    albedo *= 1.0 - bowl * 0.28;
    albedo *= 1.0 + max(cUp - cDap, 0.0) * bowl * 1.5;

    let shadow = ridgeShadow(hit.pos, hit.height, L, uniforms.ridgeAmp);

    const INV_PI: f32 = 0.31830988618;
    let diff = wrapDiffuse(dot(N, L), mix(0.15, 0.62, dustMask));
    var col = albedo * INV_PI * uniforms.sunRadiance * diff * shadow;

    // --- subsurface ---------------------------------------------------------
    // Without this the range reads as a different material from the field it
    // stands behind.
    //
    // The fines are weakly translucent — a loose aggregate of glass and mineral
    // grains, and light entering one side of a drift leaves the other. A ridge of
    // it with the star behind keeps a faint edge rather than going to a flat
    // silhouette, and that rim is part of what separates it from the void it is
    // drawn against.
    //
    // The identical term the ground runs, so the two cannot disagree about what
    // back-lit regolith does.
    let V = -dir;
    // Halved in the de-glass pass: at range the transmission rim reads as a
    // glaze on the silhouette rather than as translucency.
    col += dustSubsurface(N, L, V, uniforms.sunRadiance, 0.45, dustMask, 0.5)
         * albedo * mix(0.5, 1.0, shadow);

    // Ambient fill. At this distance it is most of what is left after
    // extinction, and out here it is the reason a distant ridge reads as
    // anything at all rather than black: the nebula above and the lit ground
    // below are the only things reaching the faces the star cannot.
    col += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Near-field bounce off the range's own slopes — the same small correction
    // the ground makes, for the same reason. The sky LUT's lower hemisphere
    // already carries the ground's solved radiance, so the sphere integral above
    // has most of this; what is added here is the part a distant uniform plain
    // cannot account for, weighted onto the downward-facing slopes it reaches.
    col += albedo * INV_PI * shIrradiance(vec3f(0.0, -1.0, 0.0), uniforms.shR)
         * uniforms.ambientIntensity * 0.25 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0)
         * dustMask;

    // The same fill the near field carries, weighted by how much regolith the
    // face is actually holding. See `DUST_EMISSION` in sky.js — the two are one
    // number, published from there, so they cannot drift apart.
    col += uniforms.dustEmission * dustMask * 0.55;

    // ---- aerial perspective ------------------------------------------------
    //
    // The scene's own, not a second atmosphere of the range's own — and that
    // change is most of what makes the range sit *in* the landscape rather than
    // behind it.
    //
    // Deliberately *not* a second, physically-real atmosphere integrated over
    // the true kilometres. That gives the frame two different atmospheres and
    // the seam lands exactly where the eye is looking: the scene's haze is
    // roughly a hundred times thicker than real air, so an 800 m dune is hazed
    // as though it were eighty kilometres away while a 20 km massif gets a
    // genuine 20 km of it — and the range comes out sharper and more contrasty
    // than the ground in front of it, which reads as a matte painting hung
    // behind the set.
    //
    // What makes one atmosphere work at these distances is the height falloff
    // the field's fog already has: at 0.045 per metre the haze has a 22 m scale
    // height, so a summit at two kilometres sits almost entirely clear of it
    // while its feet catch what little there is. And there is now very little:
    // the density came down to a fifth in the vacuum pass, because from a
    // summit the old value put everything past a kilometre and a half at
    // 60-97% extinction — a featureless pale wash with the range floating on
    // top of it, which was the floating-mountains report all three times it
    // was filed. The range now keeps most of its contrast to the last massif,
    // the way an airless horizon actually does, and this inscatter path is a
    // seasoning rather than a wall.
    let hitPos = vec3f(hit.pos.x, hit.height, hit.pos.y);
    let t = aerialTransmittance(
        uniforms.cameraPosition, hitPos,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart
    );
    let ext = clamp(1.0 - pow(t, uniforms.aerialStrength), 0.0, 1.0);

    // The identical inscatter the ground converges to. This is the part that has
    // to match exactly: the clipmap's far edge and the range's feet are adjacent
    // pixels in the frame, and if they resolve to two different "fully hazed"
    // colours there is a visible line between them whatever else is right. At
    // full extinction it is the plain sky lookup, which is what this shader draws
    // where the march missed — so a fully hazed massif and the sky beside it are
    // literally the same value.
    let inscatter = aerialInscatterSky(
        skyLUT, skyLUTSampler, dir, L, uniforms.sunRadiance, ext
    );

    return mix(col, inscatter, ext);
}

// ----------------------------------------------------------------- planets
//
// A family of three worlds, drawn analytically in the skybox the way the stars
// are: screen-space, full resolution, never in the bake. That last part is the
// point of doing it here — the LUT is 512x256 and everything in it comes out
// as a soft smear, which is exactly the complaint the old aurora curtains
// earned. An analytic disc is crisp at any resolution for the cost of a few
// noise calls on the pixels it covers.
//
// They are scenery, not sources: the hero's lit face tops out near 3 linear,
// well under the bloom knee, so the bright beautiful things in the sky are
// also the things guaranteed never to glow. The hero is teal-blue — the cool
// counterweight the palette's warm gold has been missing, and the hue every
// reference image the request came with had in common. The companions sit
// against it: a small amber world high on the other side of the sky, and a
// dim violet one low near the band.

const PLANET_DEEP: vec3f = vec3f(0.050, 0.115, 0.135);
const PLANET_PALE: vec3f = vec3f(0.360, 0.640, 0.660);
const PLANET_STORM: vec3f = vec3f(0.700, 0.860, 0.840);
const P2_DEEP: vec3f = vec3f(0.150, 0.080, 0.045);
const P2_PALE: vec3f = vec3f(0.610, 0.410, 0.240);
const P2_STORM: vec3f = vec3f(0.820, 0.640, 0.430);
const P3_DEEP: vec3f = vec3f(0.095, 0.080, 0.150);
const P3_PALE: vec3f = vec3f(0.440, 0.390, 0.590);
const P3_STORM: vec3f = vec3f(0.680, 0.630, 0.800);
// The Mars-like one, low on the horizon: rust and butterscotch, with the
// "storm" slot doing duty as pale dust-basin ground. Its band frequency is
// the lowest of the four, so what the bands read as is albedo provinces —
// maria and highlands — rather than a gas giant's stripes.
const P4_DEEP: vec3f = vec3f(0.140, 0.062, 0.034);
const P4_PALE: vec3f = vec3f(0.560, 0.290, 0.150);
const P4_STORM: vec3f = vec3f(0.720, 0.490, 0.340);
// The ember world: a young gas giant still hot from its own formation,
// which is the honest licence for a planet that visibly glows — it is not
// reflecting the star, it is radiating. Crimson depths, rose banding, and
// storms swirling up toward white-pink.
const P5_DEEP: vec3f = vec3f(0.300, 0.035, 0.060);
const P5_PALE: vec3f = vec3f(0.850, 0.160, 0.220);
const P5_STORM: vec3f = vec3f(1.000, 0.550, 0.500);

/// Shade one world. Returns (radiance, coverage); coverage 0 outside the disc,
/// easing over the last ~1.5% of radius so the limb is a couple of anti-aliased
/// pixels rather than a stair-stepped circle — at the hero's new size the edge
/// is hundreds of pixels of circumference and a hard cut reads as a sticker.
///
/// `detail` is 1 for the hero and 0 for the companions: the extra octave and
/// the storm oval only exist where there are pixels to show them, and a
/// two-degree disc is not where.
fn shadeGlobe(
    dir: vec3f, pdir: vec3f, paxis: vec3f, size: f32,
    deep: vec3f, pale: vec3f, storm: vec3f,
    bandFreq: f32, seed: f32, detail: f32, selfLit: f32
) -> vec4f {
    // Disc-local frame, and the view ray's coordinates in it.
    let U = normalize(cross(pdir, paxis));
    let W = cross(pdir, U);
    let sr = sin(size);
    let px = dot(dir, U) / sr;
    let py = dot(dir, W) / sr;
    let rr = px * px + py * py;
    if (rr >= 1.0) { return vec4f(0.0); }
    let pz = sqrt(1.0 - rr);

    // Outward normal of the sphere at the point this ray sees.
    let N = normalize(U * px + W * py - pdir * pz);

    // Latitude bands, warped so no boundary is a clean line, with pale storm
    // streaks worked along them. All of it keys off the *normal*, so the
    // pattern wraps the sphere correctly and forever — there is no texture to
    // run out of. The fine octave shears the band edges at a scale that only
    // resolves on the hero — it is what keeps a fifteen-degree disc looking
    // drawn at full resolution rather than scaled up.
    let lat = dot(N, paxis);
    let wob = noise2(vec2f(lat * 6.5, px * 2.3 + py * 0.7) + vec2f(seed, seed * 2.8)) * 0.55;
    let fine = noise2(vec2f(lat * 46.0 + wob * 7.0, px * 8.3 + py * 3.1 + seed)) * detail;
    // A fourth, still finer octave, added when the hero grew to forty degrees:
    // at that size the 46-cycle octave alone is features tens of pixels wide,
    // which is "scaled up", not "high res". This one puts texture inside them.
    let fine2 = noise2(vec2f(lat * 118.0 - wob * 9.0, px * 20.0 + py * 7.5 + seed * 3.0)) * detail;
    let bandT = sin(lat * bandFreq + wob * 3.4 + fine * 1.3 + fine2 * 0.55) * 0.5 + 0.5;
    let swirl = noise2(vec2f(lat * 21.0 + wob * 5.0, px * 3.1 + 2.4 + seed)) * 0.5 + 0.5;
    var alb = mix(deep, pale, bandT);
    alb = mix(alb, storm, swirl * swirl * 0.30);
    // Bright filaments where the fine octave crests inside a shear zone, dark
    // threads where it troughs, and one pale storm oval per world's seed —
    // the anticyclone every gas giant photograph has exactly one of.
    alb = mix(alb, storm, smoothstep(0.55, 0.90, swirl) * max(fine + fine2 * 0.4, 0.0) * 0.9);
    alb = mix(alb, deep, max(-fine - fine2 * 0.4, 0.0) * 0.55);
    let eye = noise2(vec2f(lat * 9.0 + seed * 1.7, px * 4.2 - py * 1.6 + 7.7));
    alb = mix(alb, storm, smoothstep(0.34, 0.50, eye) * 0.75 * detail);

    // Lit by the same star as everything else, with a soft gas-giant
    // terminator, limb darkening, and a thin bright arc of atmosphere on the
    // lit limb — small, because "without a crazy glow effect" was the brief.
    let ndl = dot(N, uniforms.sunDir);
    var day = smoothstep(-0.14, 0.38, ndl) * (0.30 + 0.70 * clamp(ndl, 0.0, 1.0));
    // A self-luminous world has no night side worth the name: its own heat
    // floors the terminator, so the banding stays readable all the way
    // round and only *deepens* toward the dark limb.
    day = max(day, 0.42 * selfLit);
    let limbDark = 0.55 + 0.45 * pz;
    var rim = pow(1.0 - pz, 3.0) * smoothstep(-0.25, 0.45, ndl) * 0.30;
    // The glowing rim is most of the read in the reference: hot atmosphere
    // seen edge-on through a longer path. Wider and star-independent.
    rim = rim + selfLit * pow(1.0 - pz, 2.2) * 0.55;

    // The inner glow: a faint self-lit body, strongest at the centre of the
    // disc and independent of the star, so the night side is a dim luminous
    // crescent instead of a bite out of the star field. Small — it lifts the
    // lit face by under a tenth — but it is what reads as "glowing from
    // within" rather than "lit from without".
    let inner = mix(deep, pale, 0.6) * (0.30 + 0.70 * pz)
        * (0.10 + 0.08 * detail + 0.55 * selfLit);

    let radiance = (alb * day * limbDark + pale * rim + inner) * uniforms.planetGlow;
    let cover = smoothstep(1.0, 0.985, sqrt(rr));
    return vec4f(radiance, cover);
}

/// The point-star field.
///
/// Screen-only, and deliberately so: this never enters the bake. At the 64x32
/// the spherical-harmonic readback runs at, a star is far smaller than a texel,
/// and what the projection returns is not a star field but a randomly-tinted
/// ambient that jumps every time the star moves. Stars light nothing here. They
/// cost one hash and they are drawn over the top.
///
/// Cells are laid out on the six faces of a cube rather than in lat-long UV.
/// Lat-long is shorter by two lines and puts a visible pinch of crowded stars at
/// the zenith — which is exactly where the camera looks when you drop into a
/// trough and pitch up out of it.
fn starField(dir: vec3f, density: f32, t: f32) -> vec3f {
    let a = abs(dir);
    var uv: vec2f;
    var face: f32;
    if (a.x >= a.y && a.x >= a.z) {
        uv = dir.yz / a.x;
        face = select(0.0, 1.0, dir.x < 0.0);
    } else if (a.y >= a.z) {
        uv = dir.xz / a.y;
        face = select(2.0, 3.0, dir.y < 0.0);
    } else {
        uv = dir.xy / a.z;
        face = select(4.0, 5.0, dir.z < 0.0);
    }

    // One candidate star per cell, and only the containing cell is tested — so
    // the whole field is a single hash regardless of how many stars are in it.
    const N: f32 = 96.0;
    let g = uv * N;
    let cell = floor(g);
    let f = g - cell;

    let h = hash33(vec3f(cell, face * 37.0));
    if (h.z > 0.42 * density) { return vec3f(0.0); }

    // Held off the cell edges, because only one cell is sampled: a star centred
    // on a boundary would be sliced in half by the cell it does not belong to.
    let centre = clamp(h.xy, vec2f(0.25), vec2f(0.75));
    let d = length(f - centre);

    // Apparent magnitude, cubed. A real field is overwhelmingly faint stars with
    // a handful of bright ones; a uniform distribution reads as static.
    let m = hash21(cell + vec2f(face * 11.0, 3.7));
    let mag = m * m * m;

    // Twinkle. There is no air to scintillate out here, so this is small and
    // slow — the eye's own adaptation rather than the atmosphere's turbulence —
    // and every star gets its own rate and phase so the field never pulses.
    let tw = 0.80 + 0.20 * sin(t * (0.6 + m * 2.4) + h.x * 62.8);

    // ~2 px across at 1440p. Smaller than that and TAA treats each star as
    // sub-pixel noise and dissolves the field into a faint grey haze.
    //
    // Except the beacons: the top ~2% of the magnitude curve draw at roughly
    // twice the diameter and brighter still. Two sizes is what turns a stipple
    // into a field with *depth* — a couple of obviously nearer stars against a
    // background of far ones — and every beacon is forced into one of the
    // saturated classes below, because a big star with no colour reads as a
    // rendering artefact rather than a sun.
    let beacon = step(0.976, m);
    let core = exp(-d * d * mix(420.0, 150.0, beacon))
             * (0.35 + 3.4 * mag) * (1.0 + beacon * 0.9);

    // Colour by spectral class, roughly: hot blue-white through to cool amber,
    // with the bright end of the population running warm to sit with the gold.
    var col = mix(vec3f(0.74, 0.82, 1.0), vec3f(1.0, 0.80, 0.56), h.y * 0.7 + mag * 0.3);

    // And a scattering of genuinely coloured ones — about one star in seven,
    // in four saturated classes, so the field reads as a population rather
    // than a white stipple. The tints are strong because a two-pixel point
    // has no area to carry a subtle one: by the time TAA and the display have
    // had it, "slightly blue" is white.
    let jewel = fract(h.x * 57.31 + h.y * 13.77);
    if (jewel > 0.86 || beacon > 0.5) {
        let pick = fract(jewel * 41.7);
        if (pick < 0.30)      { col = vec3f(0.52, 0.62, 1.0); }    // sapphire
        else if (pick < 0.58) { col = vec3f(1.0, 0.52, 0.28); }    // ember
        else if (pick < 0.82) { col = vec3f(0.50, 0.95, 0.86); }   // teal
        else                  { col = vec3f(1.0, 0.58, 0.76); }    // rose
    }
    return col * core * tw;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = normalize(input.vDir);
    let uv = dirToLatLong(dir);

    var col = textureSampleLevel(skyLUT, skyLUTSampler, uv, 0.0).rgb;

    // ------------------------------------------------------- far-field range
    // Above the band the march's ceiling test rejects immediately, so the upper
    // bound is only there to skip the call. 0.32 rather than the 0.230 it was:
    // the near massifs grew to 2,900 m, whose tops from the valley floor sit
    // right at 0.23 — a cap there sliced them flat.
    //
    // The lower bound reaches well *below* the horizon on purpose, and how far
    // below is set by the tallest thing the player can stand on. The clipmap is
    // drawn *after* the sky and covers everything below its own silhouette, so
    // the range only has to paint far enough down that the terrain always takes
    // over before the window runs out. The old floor of -0.05 assumed an eye
    // two metres up, where a ray at -0.05 meets ground within eighty metres;
    // the moon rework put hundred-metre massifs under the player, and from a
    // summit the clipmap's far edge sits at -0.18 — everything between showed
    // the LUT's raw below-horizon hemisphere, a flat pale band with the range
    // floating above it. At -0.35 the window outlasts the silhouette from any
    // standable height with margin. Below the horizon the march is cheap: the
    // ray starts inside the range's empty seven-kilometre bowl and hits its
    // floor on the first sample, which shades as a fully hazed distant plain —
    // the same colour the clipmap's own far edge converges to, so the two meet
    // instead of leaving a seam.
    // ------------------------------------------------------------- the world
    // Behind the range, in front of the stars — the gates below keep all three
    // honest. See `shadeGlobe`.
    var planetHit = false;
    if (uniforms.planetGlow > 0.001
        && (dot(dir, uniforms.planetDir) > cos(uniforms.planetSize)
         || dot(dir, uniforms.planet2Dir) > cos(uniforms.planet2Size)
         || dot(dir, uniforms.planet3Dir) > cos(uniforms.planet3Size)
         || dot(dir, uniforms.planet4Dir) > cos(uniforms.planet4Size)
         || dot(dir, uniforms.planet5Dir) > cos(uniforms.planet5Size))) {
        planetHit = true;   // provisional; confirmed against the discs below
    }

    // The floor tracks the eye: the band that has to be covered reaches down to
    // the clipmap's far edge, which from a summit is much lower than from the
    // deck. Computing it from the camera height rather than fixing it at the
    // worst case keeps the ordinary surfing frame from paying for pixels the
    // terrain is about to draw over anyway.
    let ridgeFloor = clamp(-(uniforms.cameraPosition.y + 140.0) / 870.0, -0.35, -0.06);
    var ridgeHit = false;
    if (uniforms.ridgeAmp > 1.0 && dir.y < 0.32 && dir.y > ridgeFloor) {
        let hit = ridgeMarch(uniforms.cameraPosition, dir, uniforms.ridgeAmp);
        if (hit.hit) {
            col = shadeRidge(hit, dir);
            ridgeHit = true;
            planetHit = false;   // a mountain in front of a planet wins
        }
    }

    if (planetHit) {
        // The three cones never overlap — the companions are placed a third of
        // the sky away from the hero — so the first disc that takes the pixel
        // is the only one that could have.
        var pc = vec4f(0.0);
        if (dot(dir, uniforms.planetDir) > cos(uniforms.planetSize)) {
            pc = shadeGlobe(dir, uniforms.planetDir, uniforms.planetAxis,
                            uniforms.planetSize, PLANET_DEEP, PLANET_PALE,
                            PLANET_STORM, 13.0, 3.1, 1.0, 0.0);
        }
        if (pc.a <= 0.0 && dot(dir, uniforms.planet2Dir) > cos(uniforms.planet2Size)) {
            pc = shadeGlobe(dir, uniforms.planet2Dir, uniforms.planet2Axis,
                            uniforms.planet2Size, P2_DEEP, P2_PALE,
                            P2_STORM, 9.0, 11.4, 0.0, 0.0);
        }
        if (pc.a <= 0.0 && dot(dir, uniforms.planet3Dir) > cos(uniforms.planet3Size)) {
            pc = shadeGlobe(dir, uniforms.planet3Dir, uniforms.planet3Axis,
                            uniforms.planet3Size, P3_DEEP, P3_PALE,
                            P3_STORM, 11.0, 21.9, 0.0, 0.0);
        }
        if (pc.a <= 0.0 && dot(dir, uniforms.planet4Dir) > cos(uniforms.planet4Size)) {
            pc = shadeGlobe(dir, uniforms.planet4Dir, uniforms.planet4Axis,
                            uniforms.planet4Size, P4_DEEP, P4_PALE,
                            P4_STORM, 4.5, 33.2, 0.0, 0.0);
        }
        if (pc.a <= 0.0 && dot(dir, uniforms.planet5Dir) > cos(uniforms.planet5Size)) {
            pc = shadeGlobe(dir, uniforms.planet5Dir, uniforms.planet5Axis,
                            uniforms.planet5Size, P5_DEEP, P5_PALE,
                            P5_STORM, 8.0, 47.6, 1.0, 1.0);
        }
        if (pc.a <= 0.001) { planetHit = false; }   // grazed the corner of a cone
        else {
            // Blend at the limb, replace inside it. The star field and the
            // aureole stay gated on the *solid* part only, so the two or three
            // anti-aliased edge pixels can show a star dimming out behind the
            // limb rather than a hard notch.
            col = mix(col, pc.rgb, pc.a);
            planetHit = pc.a > 0.5;
        }
    }

    // ------------------------------------------------------------- the star
    // A third of a degree across, with limb darkening — smaller and harder than
    // the sun seen from Earth, because this one is further away and there is no
    // air to soften its edge.
    //
    // Its radiance is arbitrary. Anything that clears the AgX shoulder reads as
    // pure white, and the disc clears it by two orders of magnitude at any value
    // that has ever been in here — so what this number sets is not the star's
    // brightness but what the rest of the chain does with it downstream.
    //
    // The Karis average on the prefilter level is what makes the disc's own value
    // nearly irrelevant, and it took measuring to see it. The disc is eight pixels
    // across at 1440p — two at the quarter-resolution bright pass — so it is an
    // isolated bright sample in a group of thirteen taps that are otherwise void,
    // and weighting each group by 1/(1+luma) before averaging pulls the group's
    // result down to order 1. The threshold at 6.5 then removes it entirely. The
    // disc contributes essentially nothing to the glare pattern at any value here,
    // which is exactly the mechanism the point-star field relies on.
    //
    // So this number is now set by the temporal resolve rather than by the bloom:
    // 1.6 puts the disc at ~370 linear, still far above the AgX shoulder and so
    // still a hard white point, without handing TAA a value three orders of
    // magnitude off its neighbours to reproject.
    let mu = dot(dir, uniforms.sunDir);
    let discCos = cos(0.0029);
    if (mu > discCos && !ridgeHit && !planetHit) {
        let r = sqrt(max(0.0, 1.0 - mu * mu)) / 0.0029;
        let limb = pow(max(0.0, 1.0 - r * r * 0.72), 0.42);
        col += uniforms.sunColor * uniforms.sunIntensity * 1.6 * limb;
    }
    // The aureole is not atmospheric. In vacuum a bright point source has no halo
    // *in the scene*; the halo is in the instrument, and this scene is being
    // watched through one.
    //
    // Which is the argument for keeping it small, and the previous pair were not.
    // `pow(mu, 2600)` has a two-and-a-half-degree full width — sixty pixels at
    // 1440p — and at 0.5 its peak was 59 in linear, so the star came with a
    // hundred-pixel-wide patch of near-white (output 219 at two degrees out,
    // against ground lit to 175) before the bloom pass had even seen it. Then the
    // bloom pass did see it: 227,000 px-linear over the threshold, spread across
    // the frame.
    //
    // The pair below is the same idea at the right scale. The tight lobe is one
    // degree wide, hugging the eight-pixel disc, and peaks at 6 — a bright ring
    // on the disc's edge, over the threshold across a couple of hundred pixels
    // rather than tens of thousands. The wide one is a four-degree haze a third
    // of a linear unit tall that never blooms at all and exists only so the
    // star sits in the sky rather than being pasted on top of it. Both came
    // down another quarter in the crisp-sky pass: with the band dimmed and the
    // aurora off, the haze was the widest soft thing left in the frame.
    // Occluded by the range along with the disc — the analytic part of the glow
    // is scene light and a mountain in front of it blocks it. The instrument's
    // own glare survives: the bloom pass reads the final frame, so a star
    // half-behind a summit still spills over the silhouette the way glare does.
    let aureole = pow(max(0.0, mu), 20000.0) * 0.056 + pow(max(0.0, mu), 300.0) * 0.0019;
    col += uniforms.sunColor * uniforms.sunIntensity * aureole * 0.5
         * select(1.0, 0.0, ridgeHit || planetHit);

    // --------------------------------------------------------------- stars
    // Added last and additively, over everything except the star's own disc.
    // Stars sit *in front of* the nebula from here, and a nebula that occludes
    // its own foreground stars is the single most common tell in a painted
    // space background.
    // The gain is stated against `sunIntensity` so the field tracks the star it
    // is drawn beside. 0.0138 rather than the 0.010 it was, which is the
    // reciprocal of the drop in `SUN_SCALE_BASE` — the star scale came down when
    // the ground stopped being dust and started being rock, and the point of that
    // change was to move the ground, not to dim the sky.
    //
    // Gated off the range. Stars sit in front of the *nebula* — a nebula that
    // occluded its own foreground stars would be the painted-backdrop tell —
    // but they are thousands of times further away than a mountain, and a
    // summit with stars twinkling on its face is the same tell in the other
    // direction.
    if (!ridgeHit && !planetHit) {
        col += starField(dir, uniforms.starDensity, uniforms.time)
             * uniforms.starBrightness * uniforms.sunIntensity * 0.0138;
    }

    fragmentOutputs.color = vec4f(col, 1.0);
}
