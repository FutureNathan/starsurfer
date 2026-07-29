// -----------------------------------------------------------------------------
// Star Crystal — lattice shading.
//
// What sells this power is not the geometry. It is that a facet of a grown
// lattice does three different things depending on where you stand relative to
// it, all at once and all sharply divided by the facet edges:
//
//   near grazing   almost a mirror. Fresnel at 0.021 base reflectance still
//                  returns nearly everything at 80 degrees, and out here what it
//                  returns is the galactic band — a hard bright edge against a
//                  near-black sky.
//   head on        you see through it, bent, and tinted by the path. This is the
//                  one surface in the demo that shows the backdrop *displaced*,
//                  because it is the only one with a real refractive index; the
//                  plasma bodies sit at 0.98 and barely bend a ray at all.
//   backlit        it glows. The lattice scatters at every trapped grain, and a
//                  crystal with the star behind it lights up along its whole
//                  length rather than going to silhouette.
//
// And a fourth thing, which is what makes the other three survive out here: it
// emits. Ordering loose dust into a lattice sheds the charge those grains were
// carrying, so a crystal is brightest while it is growing and settles to a low
// violet afterwards. Every one of the three terms above is ultimately fed by the
// sky, and the sky here is the void — a mirror with nothing to mirror is black,
// so without a source of its own a formation is a cluster of dark glassy spikes.
//
// **Blended, but depth-writing.** The usual pair of options is opaque (correct
// depth, no transparency) or alpha-blended with depth write off (transparency,
// no depth). Neither is right for a cluster of forty overlapping prisms: the
// first gives violet spikes standing on the dust, and the second gives a grey
// smear where every prism blends over every other one in index order.
//
// Writing depth while blending gives the third thing. The first surface at a
// pixel blends over whatever the dust and the astronaut already put there — so
// you genuinely see the sea through the lattice — and every surface *behind* it
// is depth-rejected, so no crystal is ever blended over another one. The result
// is order-dependent in principle and completely stable in practice, because the
// only thing the order decides is which face of a solid you see, and any of them
// is a correct answer.
//
// It is kept even though the crystals emit, and that is a real decision rather
// than an oversight: an emitter you would want to *accumulate* is a
// volume, and this is not one. A prism is a solid with a boundary, so two of
// them overlapping should show the near one, not the sum. Turning depth write
// off to let them add would bring back exactly the order-dependent grey smear
// described above and buy nothing but a brighter middle of the cluster.
//
// The normal comes from the derivatives of the world position, so every facet is
// exactly flat and the edges between them are exactly hard. That hard edge is
// what makes the material read: adjacent facets of one prism return wildly
// different amounts of sky, and that facet-to-facet jump *is* the look of a
// grown crystal.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>

varying vWorld: vec3f;
varying vBase: vec3f;
varying vHeight01: f32;
varying vSeed: f32;
varying vGrowth: f32;
varying vGlow: f32;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;
uniform sssStrength: f32;
uniform glintIntensity: f32;
uniform glintGrazing: f32;
/// What the lattice emits, radiance already folded in — Star Crystal's own hue
/// and gain, so the prisms, the light they cast and the patch they leave in the
/// ground are one colour. See `crystals.js`.
uniform crystalGlowColor: vec3f;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<starShadowLookup>

/// Extinction per metre through the lattice.
///
/// Strongly wavelength-dependent, and the ordering is what makes the material:
/// red dies first and green not far behind, so a hand-sized prism shows the
/// violet a metre-sized one really would. Not so strong that the whole formation
/// saturates to one flat colour, which is what a red coefficient near four did.
///
/// Unlike the plasma bodies, this is *not* also the emission spectrum. There the
/// medium that absorbs is the medium that emits and Kirchhoff ties the two
/// together; here the lattice does the absorbing and the grains locked inside it
/// do the emitting, so the two spectra are independent and the glow is the
/// crystal's own colour at every thickness.
const LATTICE_EXTINCT: vec3f = vec3f(2.35, 1.90, 0.72);

/// Reflectance of the dust the crystal grew through and is still packed with.
///
/// The dust field's own loose value, and it has to be: the skirt where a prism
/// meets the sea *is* that sea, disturbed. The magnitude matters as much as the
/// hue — the star's radiance is set so a nine-percent surface lands near linear
/// 5, so a reflectance up near 0.9 in here renders at ten times the brightness of
/// the ground and puts a clipped white collar around the bottom of every
/// crystal.
const PACKED_ALBEDO: vec3f = vec3f(0.124, 0.091, 0.216);

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Flat facet normal, from the geometry itself.
    let dx = dpdx(world);
    let dy = dpdy(world);
    var N = normalize(cross(dx, dy));
    if (dot(N, V) < 0.0) { N = -N; }
    let geoN = N;

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- the packed skirt ---------------------------------------------------
    // Where the crystal comes out of the sea it is not clear — it is full of the
    // dust it grew through, still loose and unordered. That gradient is what
    // attaches it to the ground; without it a crystal looks placed on the surface
    // rather than grown out of it, which is the single failure this effect cannot
    // afford. Confined to the bottom fifth: any more of it than that is a dusty
    // prism with a clear tip rather than a lattice standing in the sea.
    let grain = noise2(world.xz * 34.0 + input.vSeed * 19.0) * 0.5 + 0.5;
    let packed = clamp(
        (1.0 - smoothstep(0.01, 0.22, input.vHeight01)) * (0.45 + 0.6 * grain),
        0.0, 1.0
    );

    // Optical path through the crystal: long across a facet seen edge-on, short
    // through one seen face-on, and longer near the thick base than at the tip.
    // The constant term carries the colour through the middle of the prism; a
    // path that only opens up at grazing puts all of the violet on the
    // silhouette, where the Fresnel reflection then replaces it with sky.
    let path = clamp(
        (0.16 + 0.42 * (1.0 - input.vHeight01)) * (0.7 + 2.0 * (1.0 - NdotV)),
        0.02, 1.4
    );
    let transmit = exp(-LATTICE_EXTINCT * path);

    // ---- refraction, with dispersion ---------------------------------------
    // Same construction as the plasma bodies: the sky LUT holds both the galaxy
    // and the solved radiance of the dust sea, so one lookup along the refracted
    // ray is a physically-derived estimate of what is behind the crystal in any
    // direction. Unlike them, this is a real dielectric with a real index, so the
    // ray genuinely moves and the displacement is visible — the one surface here
    // that behaves as a lens.
    let mirror = reflect(-V, N);
    let rr = refract(-V, N, 1.0 / 1.3050);
    let rg = refract(-V, N, 1.0 / 1.3090);
    let rb = refract(-V, N, 1.0 / 1.3170);
    let dr = select(mirror, rr, dot(rr, rr) > 0.5);
    let dg = select(mirror, rg, dot(rg, rg) > 0.5);
    let db = select(mirror, rb, dot(rb, rb) > 0.5);

    let behind = vec3f(
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dr), 0.9).r,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dg), 0.9).g,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(db), 0.9).b
    );
    var color = behind * transmit;

    // ---- internal transport -------------------------------------------------
    // A crystal with the star behind it lights along its whole length: the light
    // enters the far facet, scatters off the grains trapped in the lattice, and
    // leaves toward the eye, tinted by everything it did not survive.
    //
    // The tint is a *scattering albedo*, not a hue, so it sits at the scale of the
    // thing doing the scattering — dust at a tenth reflectance. It is allowed to
    // come out a stop or two above the ground and no further: a backlit crystal
    // glowing is the read, a backlit crystal clipping is a hole in the frame.
    //
    // The 1/PI belongs in front of a scattering lobe; see the same note in the
    // plasma material, where leaving it out clipped the whole body to white.
    let through = backScatter(N, L, V, 0.42, 2.2, 1.0);
    let deepTint = mix(vec3f(0.13, 0.075, 0.28), vec3f(0.24, 0.215, 0.30), exp(-path * 2.5));
    color += sun * INV_PI * deepTint * through * uniforms.sssStrength * 1.35
           * mix(0.25, 1.0, shadow);

    // Sky through the body. Out here the useful half of that is the dust sea from
    // below rather than a dome from above, and it is what keeps a crystal
    // standing in the star's shadow alive rather than black.
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
           * deepTint * 0.9;

    // ---- packed skin --------------------------------------------------------
    if (packed > 0.002) {
        var fc = PACKED_ALBEDO * INV_PI * sun * wrapDiffuse(NdotL, 0.62) * shadow;
        fc += PACKED_ALBEDO * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
        fc += dustSubsurface(N, L, V, sun, 0.4, uniforms.sssStrength, 1.3)
            * PACKED_ALBEDO * mix(0.4, 1.0, shadow);
        color = mix(color, fc, packed * 0.9);
    }

    // ---- surface ------------------------------------------------------------
    // The mirror half of the material, and the only true one left in the scene.
    // f0 0.021 is a real dielectric's normal-incidence reflectance; near grazing
    // this returns nearly everything, and a hard bright facet edge carrying the
    // galactic band is the single clearest read this material has.
    let rough = mix(0.045, 0.42, packed);
    let F = fresnelSchlick(NdotV, vec3f(0.021));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), rough * 6.0).rgb;
    color = mix(color, skyRefl, F * (1.0 - packed * 0.75));

    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.021));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    // Grains on the skirt catching the star as points, out of the same function
    // the dust field uses. Full strength, and it is meant to be far brighter than
    // the surface it sits on: a mirror facet returns the *source* radiance
    // whatever the albedo around it is, so under a star this bright a glint is a
    // hard point of starlight rather than a highlight on dust.
    if (uniforms.glintIntensity > 0.001) {
        let g = dustGlints(
            world.xz, N, V, L, max(length(dx.xz) + length(dy.xz), 1e-4),
            uniforms.glintIntensity * (0.4 + 1.2 * packed), uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.6;
    }

    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, PACKED_ALBEDO * mix(0.6, 1.0, packed),
            vec3f(0.021), rough, 0.5,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- the lattice's own light --------------------------------------------
    //
    // Three things gate it, and each is a statement about what ordering dust into
    // a lattice actually does:
    //
    //   vGlow    the CPU-side temperature, already carrying both the per-crystal
    //            variation and the cooling curve. The charge is shed *while the
    //            structure forms*, so a crystal blazes as it spears up and
    //            settles to a low ember for as long as it stands — which is what
    //            makes a formation an event rather than a light fitting.
    //   height   the tip is the newest and cleanest growth; the skirt is still
    //            half loose dust and is not doing this.
    //   grazing  facets seen edge-on present the longest run of lattice and are
    //            the brightest, which is what puts a hard bright line on every
    //            facet edge — the same edge the Fresnel term draws, from the
    //            other side of the material.
    //
    // Not keyed to the optical path, deliberately. The absorption path already
    // runs from the tip to the base, and hanging the emission off it as well
    // would put the two gradients in opposition — a tip that is the newest growth
    // and also the thinnest, so hottest and dimmest at once.
    //
    // Added last, so it survives the packed skin and the Fresnel mix above it — a
    // crystal generating light must not be dimmed by having dust on it — and
    // before aerial perspective, so a formation forty metres away still hazes
    // into the sky like everything else.
    let heat = input.vGlow * mix(0.55, 1.0, input.vHeight01)
             * (0.45 + 0.55 * (1.0 - NdotV));
    color += uniforms.crystalGlowColor * heat;

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ---- opacity ------------------------------------------------------------
    //
    // Three things drive it, and they are the three things that decide how much
    // of a real crystal you can see through:
    //
    //   path      a thin tip is nearly clear; the thick base is not.
    //   grazing   a facet seen edge-on presents a long optical path and a strong
    //             reflection, and both make it opaque.
    //   packed    where the prism is full of the dust it grew through, it is not
    //             transparent at all.
    //
    // The floor is high enough that a crystal never disappears against the field
    // behind it — and it is also what decides how much of the emission above
    // survives the blend, since everything a blended surface writes is scaled by
    // its own alpha. A lattice that glowed at full radiance but composited at
    // half of it would be a formation that dimmed as it grew clearer, which is
    // backwards.
    let alpha = clamp(
        0.46 + 0.34 * (1.0 - exp(-path * 2.2)) + 0.26 * (1.0 - NdotV) + packed * 0.55,
        0.0, 1.0
    );
    fragmentOutputs.color = vec4f(color, alpha);
}
