// -----------------------------------------------------------------------------
// The regolith material.
//
// Normals arrive from four independent sources and have to be combined in the
// right order or the surface stops holding together:
//
//   macro     baked landform gradient        tens of metres → ~1 m
//   fine      analytic filaments and ripples ~2 m → ~10 cm
//   detail    tiled generated grain map      ~10 cm → ~5 mm
//   deform    the terrain state buffer       whatever the player carved
//
// Macro and fine and deform are all *heightfield gradients* in world space, so
// they add as slopes before ever becoming a normal. Only the detail map is a
// tangent-space normal, and it is folded in last with reoriented normal mapping.
// Adding normals instead of slopes is the classic way to lose the landform under
// the detail.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starTerrain>
#include<starDeform>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>

varying vWorld: vec3f;
varying vHeightUV: vec2f;
varying vViewDist: f32;
varying vSpacing: f32;

// ------------------------------------------------------------------ textures
var auxTex: texture_2d<f32>;
var auxTexSampler: sampler;
var detailTex: texture_2d<f32>;
var detailTexSampler: sampler;
var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;
var deformTex: texture_2d<f32>;
var deformTexSampler: sampler;

// ------------------------------------------------------------------ uniforms
uniform cameraPos: vec3f;
uniform sunDir: vec3f;
/// Direct starlight reaching the ground, in the same units the sky LUT stores
/// radiance in. No extinction term: there is no atmosphere between the star and
/// this surface to take one.
uniform sunRadiance: vec3f;

uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
/// Per cascade: (depth range in metres, ortho width in metres, unused, unused).
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform windAngle: f32;
uniform sastrugiAmp: f32;
uniform detailStrength: f32;
uniform glintIntensity: f32;
uniform glintGrazing: f32;
uniform sssStrength: f32;
uniform sssRadius: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

uniform worldOrigin: vec2f;
uniform worldSize: f32;

uniform deformCenter: vec2f;
uniform deformSize: f32;
uniform deformTexel: f32;
uniform deformDepthScale: f32;

uniform ambientIntensity: f32;

// --- the ground's own light --------------------------------------------------
// Master scale on everything the surface emits, and the two ends of its emission
// ramp: `dustCoolColor` is the neutral nebula fill the regolith sits in at rest,
// `dustGlowColor` is what charged ground burns at. Both are radiances rather
// than reflectances.
uniform dustEmissive: f32;
uniform dustGlowColor: vec3f;
uniform dustCoolColor: vec3f;

/// The two regolith terrains, from `brand.js`. Highland anorthosite and mare
/// basalt — see the note where they are mixed.
uniform regolithHigh: vec3f;
uniform regolithLow: vec3f;

uniform debugMode: f32;
uniform screenSize: vec2f;

// Spell lights. See `lib/spellLights.wgsl`; zero-count on almost every frame.
uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

// The cascade projection and PCSS selection live in a shared include, because
// the character material has to run the byte-identical lookup — the Y-flip
// convention and the receiver-plane gradient are exactly the sort of thing that
// two copies would quietly disagree about.
#include<starShadowLookup>

// -----------------------------------------------------------------------------

/// Diagnostic: how far the depth map and the receiver disagree, in metres.
///
/// Projects exactly as `sampleCascadeTex` does — same normal offset, same
/// cascade selection — but takes the single centre tap and returns
/// (stored - receiver) scaled to world metres. Near zero means the two passes
/// are describing the same surface and any remaining artefact is a bias or
/// filter question. Hundreds of metres means they are not, and no amount of
/// bias tuning is going to help.
fn shadowMapDelta(world: vec3f, geoN: vec3f, viewDist: f32) -> f32 {
    let sp = uniforms.cascadeSplits;
    var m = uniforms.cascadeMatrices[2];
    var params = uniforms.cascadeParams[2];
    var idx = 2;
    if (viewDist < sp.x) { m = uniforms.cascadeMatrices[0]; params = uniforms.cascadeParams[0]; idx = 0; }
    else if (viewDist < sp.y) { m = uniforms.cascadeMatrices[1]; params = uniforms.cascadeParams[1]; idx = 1; }

    let lf = -uniforms.sunDir;
    let lr = normalize(cross(vec3f(0.0, 1.0, 0.0), lf));
    let nl3 = vec3f(dot(geoN, lr), dot(geoN, cross(lf, lr)), dot(geoN, lf));
    let sinL = sqrt(clamp(1.0 - nl3.z * nl3.z, 0.0, 1.0));
    let biased = world + geoN * (params.y * uniforms.shadowTexel * 1.5 * max(sinL, 0.2));

    let clip = m * vec4f(biased, 1.0);
    let ndc = clip.xyz / clip.w;
    // 1e9 flags "this point is not inside the cascade at all".
    if (any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1e9; }

    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);
    var d = 0.0;
    if (idx == 0) { d = textureSampleLevel(cascade0, cascade0Sampler, uv, 0.0).r; }
    else if (idx == 1) { d = textureSampleLevel(cascade1, cascade1Sampler, uv, 0.0).r; }
    else { d = textureSampleLevel(cascade2, cascade2Sampler, uv, 0.0).r; }

    return (d - ndc.z) * params.x;
}

/// Unpack a two-channel tangent-space normal.
fn unpackN(rg: vec2f) -> vec3f {
    let xy = rg * 2.0 - 1.0;
    return vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

/// Triplanar detail-normal fetch. Dust on a steep shard face has no sensible
/// planar projection, and stretching the grain up a 60-degree slope is instantly
/// legible as a smear.
///
/// Gradients are passed in rather than taken here: every call site sits behind a
/// footprint test, and WGSL forbids implicit-derivative sampling under
/// non-uniform control flow. Explicit gradients keep full mip filtering — which
/// this absolutely needs, since the whole point of the fade-in is anti-aliasing.
fn detailNormal(
    world: vec3f, N: vec3f, scale: f32, blendSteep: f32,
    ddxW: vec3f, ddyW: vec3f
) -> vec3f {
    var n = unpackN(textureSampleGrad(
        detailTex, detailTexSampler, world.xz * scale,
        ddxW.xz * scale, ddyW.xz * scale
    ).xy);

    if (blendSteep > 0.01) {
        let a = unpackN(textureSampleGrad(
            detailTex, detailTexSampler, world.xy * scale,
            ddxW.xy * scale, ddyW.xy * scale
        ).xy);
        let b = unpackN(textureSampleGrad(
            detailTex, detailTexSampler, world.zy * scale,
            ddxW.zy * scale, ddyW.zy * scale
        ).xy);
        let w = abs(N);
        let sum = w.x + w.y + w.z;
        n = normalize(mix(n, (a * w.z + b * w.x + n * w.y) / sum, blendSteep));
    }
    return n;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let viewDist = input.vViewDist;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // World-space size of this pixel — drives every filtering decision below.
    // Taken once here, in uniform control flow, and threaded down to the texture
    // fetches that sit behind footprint tests.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);

    // The *narrow* axis of that footprint, which is a very different number.
    //
    // At grazing incidence a pixel's world footprint is a long thin sliver: one
    // axis blows up while the other stays small. `footprint` above averages the
    // two, so simply tilting the camera down towards the horizon inflates it by
    // an order of magnitude — and anything keyed off it fades out, even though
    // the surface is no further away and is still perfectly resolvable across the
    // sliver's short axis. For the natural detail layers that trade is fine and
    // deliberate. For a carved trail it is not: it means the trail changes shape
    // when you move the camera and not the player, which reads as a bug because
    // it is one. This is the same reasoning anisotropic texture filtering runs on.
    let footprintMin = max(min(length(ddxW.xz), length(ddyW.xz)), 1e-4);

    // ---------------------------------------------------------------- slopes
    let aux = textureSampleLevel(auxTex, auxTexSampler, input.vHeightUV, 0.0);
    var grad = aux.xy;
    let rockMask = aux.z;
    let exposure = aux.w;

    let fine = terrainFineFiltered(
        world.xz, uniforms.windAngle, exposure, uniforms.sastrugiAmp, footprint
    );
    grad += fine.yz;

    // ------------------------------------------------------------ deformation
    // Depression, displaced berm mass and compression, written by feet, the
    // surf wake and every power. Read here so lighting responds to a carved
    // trail exactly as it does to natural relief.
    var compression = 0.0;
    var iceAmount = 0.0;
    var deformDepth = 0.0;
    var deformBerm = 0.0;

    let dWeight = deformFalloff(world.xz, uniforms.deformCenter, uniforms.deformSize);
    if (dWeight > 0.001) {
        let dUV = deformUV(world.xz, uniforms.deformSize);
        let c = textureSampleLevel(deformTex, deformTexSampler, dUV, 0.0);

        // Gradient of (berm - depression), by central difference.
        //
        // The step *widens with the pixel* rather than being fixed at two texels
        // behind a distance fade. Two texels differenced at 30 m is a normal
        // sampled far below the pixel's own footprint, so it aliases. Fading it
        // out fixes the aliasing but stops the trail existing about fifteen
        // metres out, and a run should be visible from across the field.
        //
        // Widening the baseline is the better answer: it is the low-pass filter
        // the fade was standing in for. The difference stays bounded while the
        // divisor grows, so the gradient rolls off smoothly with distance instead
        // of being switched off, and the trail survives as a tonal line long
        // after it has stopped being a shape.
        //
        // Keyed to the narrow footprint axis, so the width tracks how far away the
        // dust is and not how obliquely it is being looked at.
        let step = max(uniforms.deformTexel * 2.0, footprintMin * 1.4);
        let eUV = step / uniforms.deformSize;

        let dxA = textureSampleLevel(deformTex, deformTexSampler, dUV + vec2f(eUV, 0.0), 0.0);
        let dxB = textureSampleLevel(deformTex, deformTexSampler, dUV - vec2f(eUV, 0.0), 0.0);
        let dzA = textureSampleLevel(deformTex, deformTexSampler, dUV + vec2f(0.0, eUV), 0.0);
        let dzB = textureSampleLevel(deformTex, deformTexSampler, dUV - vec2f(0.0, eUV), 0.0);
        let sx = (dxA.g - dxA.r) - (dxB.g - dxB.r);
        let sz = (dzA.g - dzA.r) - (dzB.g - dzB.r);

        // The four neighbours are already fetched, so blending them into the
        // state channels once the pixel is wider than a texel costs nothing and
        // stops a distant trail breaking into a dotted line.
        let wide = clamp(footprintMin / (uniforms.deformTexel * 4.0), 0.0, 1.0) * 0.8;
        let df = mix(c, (c + dxA + dxB + dzA + dzB) * 0.2, wide);

        deformDepth = df.r * dWeight;
        deformBerm = df.g * dWeight;
        compression = clamp(df.b, 0.0, 1.0) * dWeight;
        iceAmount = clamp(df.a, 0.0, 1.0) * dWeight;

        grad += vec2f(sx, sz) / (2.0 * step) * uniforms.deformDepthScale * dWeight;
    }

    var N = normalFromGradient(grad);

    // The surface the *depth pass* rendered: macro landform, the analytic fine
    // layer and the carved trail, but nothing finer. The shading normal picks up
    // three tiled grain scales on top of this, and biasing the shadow lookup
    // against that would describe a surface orders of magnitude higher in
    // frequency than the one in the depth map — the offset would point off in a
    // different direction on every pixel and reintroduce the noise it exists to
    // remove.
    let geoN = N;

    // ---------------------------------------------------------- detail normals
    // Three tiling scales, each faded by footprint so the finest only exists
    // when it is actually resolvable, and cross-faded so no scale ever pops in.
    let steep = smoothstep(0.55, 0.9, 1.0 - N.y);
    if (uniforms.detailStrength > 0.001) {
        var acc = vec3f(0.0, 0.0, 1.0);

        let f0 = 1.0 - smoothstep(0.004, 0.02, footprint);
        if (f0 > 0.001) {
            let d = detailNormal(world, N, 7.5, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f0));
        }
        let f1 = 1.0 - smoothstep(0.02, 0.12, footprint);
        if (f1 > 0.001) {
            let d = detailNormal(world, N, 1.7, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f1 * 0.85));
        }
        let f2 = 1.0 - smoothstep(0.1, 0.7, footprint);
        if (f2 > 0.001) {
            let d = detailNormal(world, N, 0.31, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f2 * 0.6));
        }

        // Lift the tangent-space result onto the geometric normal.
        let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
        let T = normalize(cross(up, N));
        let B = cross(N, T);
        let s = uniforms.detailStrength * mix(1.0, 0.45, compression);
        N = normalize(N + (T * acc.x + B * acc.y) * s);
    }

    let cavity = textureSampleGrad(
        detailTex, detailTexSampler, world.xz * 1.7,
        ddxW.xz * 1.7, ddyW.xz * 1.7
    ).z;

    // ------------------------------------------------------------- material
    // Lunar regolith: pulverised anorthosite and basalt, four billion years of
    // it, ground to a powder by impact and darkened further by space weathering.
    //
    // Almost nobody guesses how dark it is. The moon looks white because it is
    // the only thing in the sky and the eye has nothing to compare it against; a
    // full moon's disc is about as reflective as worn asphalt. Getting that right
    // is most of the difference between a moon and a snowfield, and the mistake
    // is very hard to unsee once it is made — a bright diffuse ground under a
    // hard raking light reads as snow whatever hue it is tinted.
    //
    // Two terrains, mixed by a slow field about six hundred metres across:
    //
    //   highland  anorthositic, the brighter and slightly warmer of the two, and
    //             what most of this field is.
    //   mare      flood basalt, roughly half as reflective and a touch bluer.
    //
    // That contrast is not decoration. It is the reason the moon has visible
    // markings from a quarter of a million miles away, and at ground level it is
    // what stops a crater field reading as one flat grey plane with holes in it.
    let mare = noise2(world.xz * 0.0016) * 0.5 + 0.5;
    var albedo = mix(
        uniforms.regolithHigh, uniforms.regolithLow, smoothstep(0.35, 0.78, mare)
    );
    var roughness = 0.78;
    var f0 = vec3f(0.020);
    var thickness = 1.0; // 1 = deep fines, 0 = thin over bedrock

    // Compacted regolith: pressed under the board. Darker, because compressing
    // the fluffy surface layer is exactly what destroys the structure that makes
    // it bright — this is why rover tracks are visible from orbit. It does not
    // become glossy; there is nothing here to melt.
    albedo = mix(albedo, vec3f(0.062, 0.058, 0.055), compression * 0.85);
    roughness = mix(roughness, 0.52, compression);
    thickness = mix(thickness, 0.35, compression);

    // Impact glass: the fourth deformation channel. Where the board's rail or a
    // power has dumped energy into the ground, the fines fuse into agglutinate —
    // a dark, genuinely mirror-like glaze, and the one thing in the scene that
    // still feeds the screen-space reflection pass. Real, too: a third of the
    // Apollo soil samples by weight is exactly this.
    albedo = mix(albedo, vec3f(0.105, 0.108, 0.118), iceAmount * 0.8);
    roughness = mix(roughness, 0.07, iceAmount);
    f0 = mix(f0, vec3f(0.045), iceAmount);
    thickness = mix(thickness, 0.15, iceAmount);

    // Bedrock, on the massif faces too steep to hold anything. Brighter than the
    // regolith rather than darker, which is the right way round and the more
    // useful one: unweathered highland rock is the most reflective thing on the
    // moon, so the mountains carry a pale edge against the sky instead of going
    // to silhouette.
    let rockExposed = rockMask * smoothstep(0.32, 0.66, 1.0 - N.y);
    if (rockExposed > 0.001) {
        let rn = noise2(world.xz * 2.3) * 0.5 + 0.5;
        let rockCol = mix(vec3f(0.078, 0.074, 0.069), vec3f(0.155, 0.148, 0.137), rn);
        albedo = mix(albedo, rockCol, rockExposed);
        roughness = mix(roughness, 0.85, rockExposed);
        thickness = mix(thickness, 0.0, rockExposed);
    }

    // --- freshly thrown mass -----------------------------------------------
    // Displaced regolith is the opposite of compacted regolith: it has just been
    // broken open and thrown, so it is loose, bright and rough. Without this the
    // berms shade identically to the trench and the whole trail flattens into
    // one smear.
    //
    // Brighter, and that is the honest answer as well as the legible one. Space
    // weathering only reaches the top few millimetres — the implanted iron that
    // darkens a mature surface is a skin — so turning it over exposes immature
    // material underneath. Apollo trenching photographs show exactly this: a
    // pale streak where the surface has been opened.
    //
    // Roughness goes *up* on loose mass, unlike snow, where a berm packs under
    // its own weight almost immediately. In a sixth of a gravity with no water
    // and no air, broken ground stays broken.
    if (deformBerm > 0.002) {
        let loose = clamp(deformBerm * 5.0, 0.0, 1.0);
        albedo = mix(albedo, vec3f(0.170, 0.158, 0.146), loose * 0.55);
        roughness = mix(roughness, 0.86, loose * 0.7);
        thickness = mix(thickness, 1.0, loose * 0.6);
        // Broken ground has facets pointing everywhere, which is where the chunky
        // granular read at a trail edge actually comes from.
        let chunk = noise2(world.xz * 34.0) * 0.5 + 0.5;
        albedo *= 1.0 - loose * 0.10 * chunk;
    }

    // Micro-occlusion in the grain crevices, and stronger in carved edges. See
    // the note where this is applied, at the bottom: it scales the whole
    // radiance, not the ambient, and it carries a blue shift with it.
    //
    // Analytic only, deliberately. A dust sea is the worst possible content
    // for a screen-space occlusion pass: an open, smooth, high-albedo surface
    // viewed at grazing angles, so the estimator has almost no real occluders to
    // find and what it returns is dominated by its own view-dependent bias — a
    // broad, soft darkening keyed to distance from the camera, which slides
    // across the ground when the camera moves and nothing else does.
    var ao = mix(1.0, cavity, 0.35 * (1.0 - smoothstep(0.02, 0.25, footprint)))
           * (1.0 - clamp(deformDepth * 1.9, 0.0, 1.0) * 0.38);

    // ------------------------------------------------------------- lighting
    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);

    // Stable per-pixel rotation for the shadow filter. IGN over pixel coords is
    // exactly the noise TAA is built to resolve.
    let pix = input.position.xy;
    let noiseRot = ign(pix) * 6.28318530718;

    var shadow = 1.0;
    if (NdotL > -0.35) {
        shadow = sunShadow(world, geoN, viewDist, noiseRot);
    }

    let sunRadiance = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // --- direct diffuse, wrapped -------------------------------------------
    // The mean free path through the fines is under a millimetre, so light wraps
    // a little past the geometric terminator. This is why the terminator on a
    // crater rim is not a razor line even where the shadow map is pin sharp. It
    // is also the *only* thing softening it: one hard star, and no sky behind it.
    let wrapAmount = mix(0.62, 0.15, max(compression, rockExposed));
    let diff = wrapDiffuse(NdotL, wrapAmount);
    var direct = albedo * INV_PI * sunRadiance * diff * shadow;

    // --- subsurface --------------------------------------------------------
    let sss = dustSubsurface(
        N, L, V, sunRadiance, thickness,
        uniforms.sssStrength * (1.0 - rockExposed), uniforms.sssRadius
    );
    // Only partly shadowed: scattered light arrives through the grains, so a
    // shadowed crest still glows along its edge. Killing this with the shadow
    // term is what would make every shadowed face go flat.
    direct += sss * albedo * mix(0.42, 1.0, shadow);

    // --- direct specular ---------------------------------------------------
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let NdotH = clamp(dot(N, H), 0.0, 1.0);
        let VdotH = clamp(dot(V, H), 0.0, 1.0);
        let D = distributionGGX(NdotH, roughness);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        let F = fresnelSchlick(VdotH, f0);
        direct += sunRadiance * D * Vis * F * NdotL * shadow;
    }

    // --- ambient -----------------------------------------------------------
    // Sky irradiance from SH. Cool by construction — it is the nebula overhead
    // and the ground's own fill — which is the other half of the warm-star /
    // cool-shadow split the whole look rests on.
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Near-field bounce, and deliberately small.
    //
    // This term used to carry most of the fill: the sky LUT's lower hemisphere
    // held a crude estimate of the ground's own radiance, so a second explicit
    // bounce was needed to make up the difference. That is no longer true. The
    // LUT now stores the dust sea's *solved* radiance below the horizon —
    // reflected starlight plus its own emission, iterated to convergence — and
    // it is the brightest hemisphere in the scene. `shIrradiance(N)` integrates
    // the whole sphere, so every downward-facing surface already receives it.
    //
    // What is left over is the part a distant uniform sea cannot describe: the
    // metre of field immediately under a crest, which is closer and brighter
    // than the average and which the SH's nine coefficients cannot resolve.
    // Small, and weighted onto downward-facing normals where it belongs.
    let bounceUp = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3f(0.0, -1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.25 * bounceUp * albedo;

    var ambient = albedo * INV_PI * irradiance;

    // Ambient specular from the sky, at a roughness-selected mip.
    let R = reflect(-V, N);
    let mip = sqrt(roughness) * 6.0;
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), mip).rgb;
    let Fr = fresnelSchlickRough(NdotV, f0, roughness);
    ambient += skyRefl * Fr * uniforms.ambientIntensity * mix(1.0, 2.6, iceAmount);

    var color = direct + ambient;

    // --- spell light -------------------------------------------------------
    // Same wrapped diffuse and the same transmission lobe the sun drives, so a
    // ribbon of lit water lying across a berm glows *through* the crest instead
    // of merely putting a bright patch on the near face. That through-scatter is
    // the whole reason the term is here rather than being a stock point light.
    //
    // The occlusion below scales this along with everything else: a spell casting
    // into an open field and a spell casting into the bottom of its own crater
    // are lighting very different amounts of visible dust.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLighting(
            world, N, V, albedo, thickness,
            uniforms.sssStrength * (1.0 - rockExposed), uniforms.sssRadius,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // --- glints ------------------------------------------------------------
    // Last, and added as radiance rather than modulated into the BRDF, because
    // a glint is a specular highlight from a crystal facet that the shading
    // normal does not represent.
    if (uniforms.glintIntensity > 0.001 && rockExposed < 0.5) {
        let g = dustGlints(
            world.xz, N, V, L, footprint,
            uniforms.glintIntensity, uniforms.glintGrazing
        );
        color += sunRadiance * g * shadow * (1.0 - iceAmount * 0.6) * 0.55;
    }

    // ---- occlusion, applied last and to everything -------------------------
    //
    // Two rules, the same two the surf wake's fragment shader carries. Both are
    // about hue rather than brightness.
    //
    //  1. It scales the *finished radiance*, not the ambient. The textbook says
    //     occlusion darkens ambient and leaves direct light alone, and in this
    //     scene that is actively wrong: the ambient is where all the blue lives —
    //     the sky is strongly blue-shifted by construction — and the sun is a
    //     13-degree beam at roughly 17:13:6. Attenuating one and not the other
    //     does not darken a surface, it re-weights a cool source against a warm
    //     one. A trench floor at 40% ambient and 100% sun is not a dark trench,
    //     it is a *brown* trench, and it lands there because AgX stops rolling
    //     saturation off half a stop below its shoulder.
    //
    //  2. Wherever it does darken, it cools in proportion. The only thing that
    //     reaches into a hollow here is the nebula overhead, and the nebula is
    //     blue-violet, so the deeper the crevice the more completely its light is
    //     that and not the star's. Far weaker than it was: the tint used to run
    //     to a saturated violet, which was right for a violet medium and is
    //     plainly wrong for grey rock. Tying it to the darkening rather than to
    //     `deformDepth` means the two cannot drift apart.
    let caveTint = mix(vec3f(1.0), vec3f(0.74, 0.76, 0.88), (1.0 - ao) * 0.95);
    color *= ao * caveTint;

    // ------------------------------------------------------- the ground's glow
    // Deep space gives this surface almost nothing. One small hard star at
    // thirteen degrees, and a sky whose integrated irradiance is a rounding error
    // beside it. Lit alone, a shadow here would be as black as the sky behind it
    // — which is what a shadow on the real moon is, and which would leave half of
    // every frame with nothing in it at all.
    //
    // So the ground carries a small amount of its own light. Two sources:
    //
    //   fill    The nebula overhead, seen through the top millimetre of fines
    //           rather than reflected off them. Neutral and cold, and weighted
    //           into the cavities so the low ground wells up and the high ground
    //           stays dark except where the star rakes it. That inversion is what
    //           makes the relief read — the eye takes form from the fill gradient
    //           where it would normally take it from N·L, and the two run in
    //           opposite directions, which is why the surface does not flatten
    //           the way an emissive-plus-lit surface usually does.
    //   charge  The deformation buffer's fourth channel: energy the board's rail
    //           or a power has dumped into the ground. Gold, and it lingers,
    //           which is what leaves a trail rather than a flash.
    //
    // Both were several times brighter, and between them they were most of what
    // made this ground read as lava — a violet field with a gold glow welling out
    // of every carved edge. The fill is now neutral and about a third of what it
    // was, and the berm glow is gone entirely: freshly turned ground is brighter
    // because it is *more reflective*, which is handled in the albedo above,
    // where a material property belongs. What is left of the charge glow is a
    // trail that clears the bloom knee and nothing else does.
    //
    // Added after the occlusion multiply and before aerial perspective. A hollow
    // that glows must not be dimmed by its own hollowness; it must still haze out
    // with distance like everything else, or the far field becomes a flat band
    // pasted in front of the sky.
    var emissive = vec3f(0.0);
    {
        let drift = noise2(world.xz * 0.035) * 0.5 + 0.5;
        let welling = mix(0.55, 1.0, 1.0 - cavity) * mix(0.7, 1.0, 1.0 - ao);
        emissive += uniforms.dustCoolColor * (0.30 + 0.70 * drift) * welling;
        emissive += uniforms.dustGlowColor * iceAmount * 0.45;
        emissive *= uniforms.dustEmissive * (1.0 - rockExposed * 0.8);
    }
    color += emissive;

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ------------------------------------------------------------------ debug
    if (uniforms.debugMode > 0.5) {
        if (uniforms.debugMode < 1.5) {
            // Depression and berm are metres and berms are the shallower of the
            // two, so both are scaled to fill the range rather than shown raw —
            // otherwise the channel that matters most reads as black.
            color = vec3f(deformDepth * 2.5, deformBerm * 5.0, compression * 0.6);
        } else if (uniforms.debugMode < 2.5) {
            color = N * 0.5 + 0.5;
        } else if (uniforms.debugMode < 3.5) {
            color = vec3f(viewDist / 400.0);
        } else if (uniforms.debugMode > 4.5 && uniforms.debugMode < 5.5) {
            // Pixel footprint, log-scaled: green ~1 cm, yellow ~10 cm, red ~1 m.
            // Every detail fade in this shader is keyed off this value, so being
            // able to see it directly turns "why is there no detail here" from a
            // guess into a reading.
            let lf = log2(footprint);
            color = vec3f(
                clamp((lf + 3.3) / 3.3, 0.0, 1.0),
                clamp(1.0 - abs(lf + 4.6) / 2.0, 0.0, 1.0),
                clamp(-(lf + 5.0) / 2.0, 0.0, 1.0)
            );
        } else if (uniforms.debugMode > 5.5 && uniforms.debugMode < 6.5) {
            // Fine + detail normal only, with the macro landform removed, so
            // the high-frequency content can be judged on its own.
            let fineN = normalFromGradient(fine.yz);
            color = fineN * 0.5 + 0.5;
        } else if (uniforms.debugMode > 6.5 && uniforms.debugMode < 7.5) {
            // The sun visibility term on its own — cast shadow only, with no
            // N.L, no albedo, no ambient and no fog. This is the one view that
            // separates "this surface faces away from the sun" from "something
            // is occluding it", which are the two completely different causes of
            // a dark frame and are otherwise indistinguishable by eye.
            //
            // Red where the surface is back-lit (NdotL < 0), because there the
            // shadow term is not what is making it dark and reading the grey
            // value would be misleading.
            color = select(vec3f(shadow), vec3f(0.35, 0.06, 0.06), NdotL <= 0.0);
        } else if (uniforms.debugMode > 7.5 && uniforms.debugMode < 8.5) {
            // Lambert term alone, same framing as the shadow view above: this is
            // the *other* half of why a pixel is dark.
            color = vec3f(max(NdotL, 0.0));
        } else if (uniforms.debugMode > 9.5) {
            // Albedo alone, before a single lighting term touches it. The one
            // view that separates "this surface is lit badly" from "this surface
            // is the wrong colour", which are otherwise indistinguishable — and
            // on a carved trail specifically, where four independent channels
            // (compression, charge, displaced mass, shard) all write here, it is
            // the only way to see which of them is talking.
            color = albedo;
        } else if (uniforms.debugMode > 8.5) {
            // Depth-map agreement, in metres.
            //   blue    = point falls outside every cascade box
            //   grey    = map and receiver agree within 0.5 m
            //   red     = map claims an occluder in front, brighter with distance
            //   green   = map sits behind the receiver (should be impossible on
            //             a closed heightfield, so it means the projection is off)
            let dz = shadowMapDelta(world, geoN, viewDist);
            if (dz > 1e8) {
                color = vec3f(0.0, 0.15, 0.6);
            } else {
                let mag = clamp(abs(dz) / 12.0, 0.0, 1.0);
                let agree = 1.0 - smoothstep(0.0, 0.5, abs(dz));
                color = vec3f(agree * 0.45)
                      + select(vec3f(0.0, mag, 0.0), vec3f(mag, 0.0, 0.0), dz < 0.0);
            }
        } else {
            let c = vec3f(f32(viewDist < uniforms.cascadeSplits.x),
                          f32(viewDist < uniforms.cascadeSplits.y),
                          f32(viewDist < uniforms.cascadeSplits.z));
            color = color * 0.6 + c * 0.25;
        }
    }

    fragmentOutputs.color = vec4f(color, 1.0);
}
