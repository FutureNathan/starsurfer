// -----------------------------------------------------------------------------
// The stardust wake — shading.
//
// This is dust that has just left the ground, and it is a different material from
// the field it came out of even though it is the same substance. Three things
// separate it, and each one drives a term below.
//
//   it is loose     Freshly broken grains scatter more than packed ones, so the
//                   wall sits at the albedo the terrain's own deformation berm
//                   resolves to rather than at the packed value beside it.
//   it is thin      A wave crest is centimetres of grains held up in the air, so
//                   it transmits: with the star low and behind it, the lip lights
//                   up from the inside rather than going to silhouette. The
//                   subsurface term is therefore driven off the section parameter
//                   — thick and opaque at the base where the wall meets the
//                   trench, thin and glowing at the lip.
//   it is hot       This is the part that carries the frame. Broken grains have
//                   far more surface per unit volume than packed ones and shed
//                   their accumulated charge at once, which is why the terrain
//                   material burns brightest along a fresh carve. The wake is
//                   that same event held in the air, so it emits, and it cools as
//                   it falls. At an albedo of twelve percent under a distant
//                   star, the emission is most of what the eye is looking at.
//
// Everything else — the cascades, the SH ambient, the glints, the aerial
// perspective — is the same code the dust field runs, out of the same includes.
// The wake has to sit in the frame as part of the same world.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>
#include<starWake>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vAmp: f32;
varying vCurl: f32;
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
uniform wakeTime: f32;

/// The discharge ramp, straight off the brand palette and matching the terrain's
/// own pair. `wakeBodyColor` is the nebula violet the whole wall wells with;
/// `wakeLipColor` is the warm gold only the hottest, freshest mass reaches. Both
/// arrive with their radiance gains already folded in — see `surfWake.js`.
uniform wakeBodyColor: vec3f;
uniform wakeLipColor: vec3f;
/// Global emission scale, shared with the dust field so the wall and the berm it
/// grows out of can never drift apart.
uniform wakeEmissive: f32;
/// Peak wall height a full-speed carve can raise, metres. The only thing this is
/// for is turning the per-column amplitude back into a 0..1 measure of how much
/// mass is actually in the air.
uniform wakeAmpRef: f32;

/// Per-term diagnostic. See the switch at the bottom; `STARSURFER.wake.debug`.
uniform wakeDebug: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<starShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let q = input.vQ;

    if (wakeEroded(input.vAlong, q, input.vAge, uniforms.wakeTime)) { discard; }

    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // The wake is an open sheet with a curl in it, so both faces are visible and
    // winding says nothing useful. Turning the normal toward the eye is right for
    // a sheet of grains a few centimetres thick — light gets through it either
    // way, and the alternative is a black inside face on the barrel.
    let Ng = normalize(input.vNormal);
    let facing = select(-1.0, 1.0, dot(Ng, V) >= 0.0);
    var N = Ng * facing;
    let geoN = N;

    // `Ng` is built by the sweep pointing to the *concave* side, so this is true
    // exactly when the eye is inside the curl. That is the one thing the shading
    // needs to know that the normal alone cannot say: the inside of a barrel of
    // dust is a cave, and it has to lose the star or the whole wall reads as a
    // cut-out lit from nowhere.
    let inside = facing > 0.0;

    // Broken grain. Cheap, and without it the wall is the one surface in frame
    // with no detail on it, which is instantly legible next to a dust field
    // carrying three scales of it.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    // Two oblique projections of the world position rather than the XZ plane.
    // The wave face is close to vertical over most of its height, so a planar XZ
    // lookup barely moves across it and the grain comes out as horizontal
    // banding — the one pattern that reads as a rendering error rather than as
    // grain. Slicing 2D noise along two non-axis-aligned directions gives a field
    // that varies at the same rate whichever way the surface is facing, for the
    // cost of two dot products.
    let gp = vec2f(
        dot(world, vec3f(0.91, 0.23, -0.35)),
        dot(world, vec3f(0.28, 0.84, 0.46))
    );
    // Two scales, each faded out by pixel footprint, mirroring what the dust
    // material does over three. One scale alone gives the wall a single
    // characteristic grain size, which is exactly how it reads as a different
    // substance from the field it was thrown out of.
    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
    let T = normalize(cross(up, N));
    let B = cross(N, T);

    let fineFade = 1.0 - smoothstep(0.012, 0.09, footprint);
    if (fineFade > 0.002) {
        let g = noised(gp * 26.0);
        N = normalize(N + (T * g.y + B * g.z) * 0.15 * fineFade);
    }
    let coarseFade = 1.0 - smoothstep(0.09, 0.55, footprint);
    if (coarseFade > 0.002) {
        let g = noised(gp * 5.5);
        N = normalize(N + (T * g.y + B * g.z) * 0.10 * coarseFade);
    }

    // ------------------------------------------------------------- material
    // Freshly displaced dust: looser, rougher and a little brighter than the pack
    // it came out of, and violet for the same reason the field is.
    //
    // This is not a free choice. It is exactly the value the terrain's own
    // deformation berm resolves to — `mix(packed, loose, 0.55)` in the dust
    // material — because the wall and the berm are one continuous body of thrown
    // mass and the wall grows straight out of it. Any seam in albedo across that
    // join reads as a ribbon pasted onto the ground, which is the single most
    // artificial thing this surface can do.
    let albedo = vec3f(0.124, 0.091, 0.216);
    // Fully loose, so the rougher end of the field's range rather than the middle.
    let roughness = 0.86;
    let f0 = vec3f(0.020);

    // Thin at the lip, deep at the base. This is the gradient the transmission
    // rests on — see the note at the top.
    //
    // The lip end does not go to zero. A wall of thrown dust is ten to thirty
    // centimetres through, not tissue: at 0.04 the transmission lobe runs at near
    // full amplitude with almost no tint, and since it is multiplied by a star
    // whose beam is roughly 231:190:139, the result is several times brighter than
    // the direct diffuse and unmistakably warm — a hot white edge all the way down
    // a wall that is supposed to be reading violet.
    let thickness = mix(0.92, 0.32, smoothstep(0.15, 0.95, q));

    // ------------------------------------------------------------- lighting
    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- occlusion ---------------------------------------------------------
    // Analytic, because the shadow map cannot supply it. The wake is a
    // zero-thickness sheet, so a point on it sits at exactly the depth its own
    // caster wrote and can never self-occlude; and under a star this low the lip's
    // cast shadow lands metres away rather than on the face beneath it. Every bit
    // of the "inside the curl is dark" read therefore has to come from here, and
    // its absence is what made the first version look like a cut-out pasted over
    // the field.
    //
    //   barrel    the concave side is enclosed by the overhang above it, and the
    //             harder the curl the less sky it sees
    //
    // Only the inside of the curl, and nothing else. Every open face has to render
    // at exactly the brightness of the mass it was thrown out of: the wall and the
    // berm at its foot are one body, and a broad gentle darkening applied to the
    // whole sheet puts a visible join between them. The wall is therefore left
    // untouched everywhere it is genuinely open, and darkened only where it is
    // genuinely enclosed.
    let barrel = select(0.0, smoothstep(0.05, 0.75, q) * (0.45 + 0.55 * input.vCurl), inside);
    let occ = mix(1.0, 0.30, barrel);

    let diff = wrapDiffuse(NdotL, 0.66);
    let directTerm = albedo * INV_PI * sun * diff * shadow;
    var color = directTerm;

    // Transmission, coupled much harder to the shadow term than the dust field's
    // is. On the ground a shadowed trough is still fed by light scattering in from
    // the lit dust a few centimetres away; a wall of grains standing in its own
    // shadow with vacuum on both sides has no such neighbour.
    //
    // Strength well under the terrain's, and a wider scattering radius so the tint
    // reaches the far end of the ramp at a lower thickness. Multiplied by an
    // albedo that is already violet, that keeps the backlit lip reading as
    // starlight coming *through* a body of dust rather than as a hot rim on it.
    let sss = dustSubsurface(N, L, V, sun, thickness, uniforms.sssStrength * 0.45, 1.5);
    let sssTerm = sss * albedo * mix(0.18, 1.0, shadow);
    color += sssTerm;

    var specTerm = vec3f(0.0);
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), roughness);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        let F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), f0);
        specTerm = sun * D * Vis * F * NdotL * shadow;
    }
    color += specTerm;

    // Ambient. One term, and only one, which is a change the sky forced.
    //
    // The sky LUT's lower hemisphere holds the dust sea's own radiance — reflected
    // starlight plus its emission, solved against the LUT until it converges — and
    // the SH is projected over the *whole* sphere of it. So a downward-facing patch
    // on the underside of the curl already collects the sea through `shIrradiance`
    // itself. A separate "bounce off the surface underneath" term would count the
    // same light a second time, and would count it through a nine-percent albedo
    // at that — a rounding error beside what the sea emits.
    let irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    let ambientTerm = albedo * INV_PI * irradiance;
    color += ambientTerm;

    let R = reflect(-V, N);
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), sqrt(roughness) * 6.0).rgb;
    let skyTerm = skyRefl * fresnelSchlickRough(NdotV, f0, roughness) * uniforms.ambientIntensity;
    color += skyTerm;

    // Spell light, above the occlusion so the barrel darkens it along with
    // everything else — a spell cast into the inside of a curl should light the
    // cave, not shine through the wall of it.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLighting(
            world, N, V, albedo, thickness,
            uniforms.sssStrength * 0.45, 1.5,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- occlusion, applied to everything reflected off the wall -----------
    //
    // It scales the *finished reflected radiance*, not just the ambient. The
    // textbook AO leaves direct light alone, but the inside of a barrel is
    // enclosed against the star exactly as much as it is against the sky — that is
    // what being inside a barrel means — and attenuating one source and not the
    // other does not darken a surface, it re-weights a warm source against a cool
    // one.
    color *= occ;

    // Grains catching the star square-on. Discrete facets, not a gloss lobe: the
    // dust sea does this too, out of the same function, and the wall has to keep
    // doing it or it stops reading as the same substance the moment it leaves the
    // ground.
    if (uniforms.glintIntensity > 0.001) {
        let g = dustGlints(
            world.xz, N, V, L, footprint,
            uniforms.glintIntensity, uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.5;
    }

    // ------------------------------------------------------------- discharge
    //
    // Broken dust sheds its charge, so the wake emits, and at the moment of
    // separation the emission is the brightest thing in the frame. Three drivers,
    // all of them already resolved by the sweep — no new state, and nothing the
    // geometry does not already know:
    //
    //   load   `vCurl`, the per-side curl the CPU resolved out of the carve. It
    //          runs 0.26 on the inboard wall of a hard turn to 1.0 on the outboard
    //          one, remapped to 0..1 here — which is exactly the split in how much
    //          mass each side is being asked to throw.
    //   mass   the column's amplitude against the tallest wall a full-speed carve
    //          can raise. This is what stops a slow drift glowing like a committed
    //          turn, and it falls away as the wall collapses.
    //   cool   age. Exponential, with a time constant near a third of the 0.88 s
    //          life — so at top speed the first five metres behind the board are
    //          visibly hotter than the ten metres behind those.
    //
    // The bloom knee at linear 3.0 is what sets the scale. At a full-speed carve
    // the crest has to clear it — that is the whole read, a board throwing light —
    // and by the time the wall has collapsed it has to be far under, because a
    // wake that blooms evenly end to end stops reading as moving material and
    // starts reading as a strip light bolted to the board.
    //
    // Added after the occlusion multiply, and deliberately exempt from it: the
    // glow comes from grains that are already inside the cave, so a hollow that
    // glows must not be dimmed by its own hollowness. That exemption is also what
    // gives the barrel its colour — everything reflective drops away and the
    // nebula violet underneath is what is left.
    let load = clamp((input.vCurl - 0.26) / 0.74, 0.0, 1.0);
    let mass = clamp(input.vAmp / max(uniforms.wakeAmpRef, 1e-3), 0.0, 1.0);
    let cool = exp(-input.vAge * 3.2);
    let lip = smoothstep(0.30, 1.0, q);
    let heat = cool * mix(0.30, 1.0, load) * mix(0.20, 1.0, mass);

    // One material at two temperatures, so the ramp is a *mix* and not a sum.
    // Adding gold on top of violet gives white, which is the one colour this
    // palette exists to avoid; interpolating keeps the crest gold, the body
    // violet, and everything between them on a continuous ramp.
    //
    // The gold fraction goes as heat *squared* so it stays confined to the crest
    // of a loaded carve instead of washing the whole sheet warm. An accent has to
    // be scarce to stay an accent.
    let gold = clamp(heat * heat * lip, 0.0, 1.0);
    let hue = mix(uniforms.wakeBodyColor, uniforms.wakeLipColor, gold);
    let emissiveTerm = hue * (heat * mix(0.60, 1.0, lip) * uniforms.wakeEmissive);
    color += emissiveTerm;

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ------------------------------------------------------------------ debug
    //
    // Per-term, because "the wall is the wrong colour" is not a question any
    // amount of staring at the composite can answer. Each mode returns one term
    // in the same radiance units the beauty pass works in, so the tonemapper
    // shows them at the exposure they actually contribute at, and two of them
    // side by side say immediately which one is carrying the hue.
    //
    //   1 direct  2 subsurface  3 ambient  4 sky spec  5 star spec
    //   6 occlusion (grey)      7 shadow (grey)        8 |N.L| (grey)
    //   9 raw N.L               10 emission            11 inside/outside
    //
    // The flat views — the three greys and the inside/outside flag — are lifted
    // onto the scene's own radiance scale, or they tonemap into the bottom of the
    // curve where nothing is separable. Lit dust sits near 5 in linear, so 5 is the
    // multiplier: a fully unoccluded, fully lit patch comes back at the brightness
    // of the ground beside it.
    const DBG_GREY: f32 = 5.0;
    let dbg = uniforms.wakeDebug;
    if (dbg > 0.5) {
        if (dbg < 1.5) { color = directTerm; }
        else if (dbg < 2.5) { color = sssTerm; }
        else if (dbg < 3.5) { color = ambientTerm; }
        else if (dbg < 4.5) { color = skyTerm; }
        else if (dbg < 5.5) { color = specTerm; }
        else if (dbg < 6.5) { color = vec3f(occ * DBG_GREY); }
        else if (dbg < 7.5) { color = vec3f(shadow * DBG_GREY); }
        else if (dbg < 8.5) { color = vec3f(max(NdotL, 0.0) * DBG_GREY); }
        // Unscaled, to line up with the dust material's own `ndotl` view — the
        // only way to compare the two surfaces is on one screen at one scale.
        else if (dbg < 9.5) { color = vec3f(max(NdotL, 0.0)); }
        // 10: the discharge alone, in scene radiance. Read it against the lit
        // dust beside it — the knee sits a little under where the field lands, so
        // anything here that is clearly brighter than the ground is blooming.
        else if (dbg < 10.5) { color = emissiveTerm; }
        // 11: which side of the sheet the eye is on. Red = inside the curl,
        // green = the open outer face. The two walls are mirror images, so this
        // is the view that says whether they agree.
        else { color = select(vec3f(0.0, DBG_GREY, 0.0), vec3f(DBG_GREY, 0.0, 0.0), inside); }
    }

    fragmentOutputs.color = vec4f(color, 1.0);
}
