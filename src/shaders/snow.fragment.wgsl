// -----------------------------------------------------------------------------
// The cosmic dust material.
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

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

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

// --- the dust's own light ----------------------------------------------------
// Master scale on everything the surface emits, and the two ends of its
// emission ramp: `dustGlowColor` is what freshly disturbed and charged dust
// burns at, `dustCoolColor` is the slow nebula glow it sits in at rest. Both
// are radiances, so both are expected to run above 1.0.
uniform dustEmissive: f32;
uniform dustGlowColor: vec3f;
uniform dustCoolColor: vec3f;

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
#include<snowShadowLookup>

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
    // Cosmic dust is a hard material to light. Its albedo is so low that
    // reflected light alone leaves the field unreadable — It is dark
    // violet — grains of silicate and ice condensing out of a nebula, seen
    // against a sky with almost nothing in it — and what gives it form is the
    // emissive block further down, not this.
    //
    // Keeping it genuinely dark matters. A pale ground under a hard raking light
    // reads as snow no matter what hue it is tinted, because the eye takes
    // "bright diffuse surface, low saturation" as snow before anything else.
    var albedo = vec3f(0.085, 0.062, 0.155);
    var roughness = 0.78;
    var f0 = vec3f(0.020);
    var thickness = 1.0; // 1 = deep drift, 0 = thin crust

    // Packed dust: compressed under the board, denser and darker still. It does
    // not become glossy — there is no melt layer out here to smooth it.
    albedo = mix(albedo, vec3f(0.045, 0.035, 0.088), compression * 0.85);
    roughness = mix(roughness, 0.52, compression);
    thickness = mix(thickness, 0.35, compression);

    // Charged dust: the fourth deformation channel. Where the board's edge or a
    // power has dumped energy into the field, the grains fuse into a smooth
    // vitrified glaze — genuinely mirror-like, and the one thing in the scene
    // that still feeds the screen-space reflection pass.
    albedo = mix(albedo, vec3f(0.16, 0.10, 0.34), iceAmount * 0.8);
    roughness = mix(roughness, 0.07, iceAmount);
    f0 = mix(f0, vec3f(0.045), iceAmount);
    thickness = mix(thickness, 0.15, iceAmount);

    // Asteroid shards standing out of the dust sea. Dust settles on the flatter
    // faces, so the mask is gated by slope rather than applied flat.
    let rockExposed = rockMask * smoothstep(0.32, 0.66, 1.0 - N.y);
    if (rockExposed > 0.001) {
        let rn = noise2(world.xz * 2.3) * 0.5 + 0.5;
        let rockCol = mix(vec3f(0.030, 0.028, 0.042), vec3f(0.072, 0.062, 0.088), rn);
        albedo = mix(albedo, rockCol, rockExposed);
        roughness = mix(roughness, 0.85, rockExposed);
        thickness = mix(thickness, 0.0, rockExposed);
    }

    // --- freshly thrown mass -----------------------------------------------
    // Displaced dust is the opposite of packed dust: it has just been broken up
    // and thrown, so it is loose, bright and rough. Without this the berms shade
    // identically to the trench and the whole trail flattens into one smear.
    //
    // Neither number here may make a worked patch *less violet*, which is the
    // one axis this material cannot afford to lose. Drain the cast out of a
    // heavily carved patch and it reads as bare ground even while its luminance
    // goes up — a neutral-grey scar across a violet field is not the same
    // material, and the eye reads it as a texturing error rather than as a trail.
    //
    //  1. The loose colour is brighter than settled dust in every channel and
    //     slightly more saturated, not less. That is also the truer answer:
    //     freshly broken grains have far more surface per unit volume and
    //     scatter more, and scattering is where the dust's colour comes from in
    //     the first place.
    //  2. Roughness goes *up* on loose mass, unlike snow, where a berm packs
    //     under its own weight almost immediately. There is no melt layer out
    //     here and nothing to press it, so broken dust stays broken — and the
    //     high roughness is what keeps the emissive glow reading as coming from
    //     inside the mass rather than off its surface.
    if (deformBerm > 0.002) {
        let loose = clamp(deformBerm * 5.0, 0.0, 1.0);
        albedo = mix(albedo, vec3f(0.155, 0.115, 0.265), loose * 0.55);
        roughness = mix(roughness, 0.86, loose * 0.7);
        thickness = mix(thickness, 1.0, loose * 0.6);
        // Broken dust has facets pointing everywhere, which is where the chunky
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
    // Snow's mean free path is millimetres, so light wraps well past the
    // geometric terminator. This is why snow shadow edges are soft even where
    // the shadow map is pin sharp.
    let wrapAmount = mix(0.62, 0.15, max(compression, rockExposed));
    let diff = wrapDiffuse(NdotL, wrapAmount);
    var direct = albedo * INV_PI * sunRadiance * diff * shadow;

    // --- subsurface --------------------------------------------------------
    let sss = snowSubsurface(
        N, L, V, sunRadiance, thickness,
        uniforms.sssStrength * (1.0 - rockExposed), uniforms.sssRadius
    );
    // Only partly shadowed: scattered light arrives through the snow, so a
    // shadowed drift lip still glows. Killing this with the shadow term is what
    // makes shadowed snow go flat and grey.
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
    // Sky irradiance from SH. Strongly blue by construction, which is the other
    // half of the warm-light / cool-shadow split that sells snow.
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Near-field bounce, and deliberately small.
    //
    // This term used to carry most of the fill: the sky LUT's lower hemisphere
    // held a crude estimate of the snow's own radiance, so a second explicit
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
        let g = snowGlints(
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
    //  2. Wherever it does darken, it goes blue in proportion. Light reaching
    //     into a hollow in snow has scattered through snow to get there, and snow
    //     absorbs red over any appreciable path — which is why a real snow cave
    //     is blue and not grey. The tint is the same `deepTint` the subsurface
    //     term uses, and tying it to the darkening rather than to `deformDepth`
    //     means the two can never drift apart.
    let caveTint = mix(vec3f(1.0), vec3f(0.62, 0.48, 1.0), (1.0 - ao) * 0.95);
    color *= ao * caveTint;

    // ---------------------------------------------------- the dust's own light
    // Deep space gives this surface almost nothing. One small hard star, and a
    // sky whose integrated irradiance is a rounding error beside it. Lit alone,
    // the field would be a black plane with a bright rim and no readable form
    // anywhere between the crests.
    //
    // So it emits. Three sources, largest scale first:
    //
    //   drift   A slow violet glow keyed to a very low-frequency noise: the
    //           nebula the field is condensing out of, seen *through* the grains
    //           rather than reflected off them. Weighted into the cavities, so
    //           the troughs well up and the crests stay dark except where the
    //           star rakes them. That inversion is what makes the swells read —
    //           the eye takes form from the emission gradient where it would
    //           normally take it from N·L, and the two run in opposite
    //           directions, which is exactly why the surface does not flatten
    //           the way an emissive-plus-lit surface usually does.
    //   fresh   Mass the board has just thrown. Freshly broken grains have far
    //           more surface per unit volume and shed their charge at once, so a
    //           carve is the brightest thing on the ground.
    //   charge  The deformation buffer's fourth channel — refrozen ice once,
    //           accumulated energy now. It burns gold and it lingers, which is
    //           what leaves a trail behind the board rather than a flash.
    //
    // Added after the occlusion multiply and before aerial perspective. A hollow
    // that glows must not be dimmed by its own hollowness; it must still haze
    // out with distance like everything else, or the far field becomes a band of
    // flat violet pasted in front of the sky.
    var emissive = vec3f(0.0);
    {
        let drift = noise2(world.xz * 0.035) * 0.5 + 0.5;
        let welling = mix(0.55, 1.0, 1.0 - cavity) * mix(0.7, 1.0, 1.0 - ao);
        emissive += uniforms.dustCoolColor * (0.30 + 0.70 * drift) * welling;
        emissive += uniforms.dustGlowColor * clamp(deformBerm * 5.0, 0.0, 1.0) * 1.2;
        emissive += uniforms.dustGlowColor * iceAmount * 1.8;
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
            // on carved snow specifically, where four independent channels
            // (compression, ice, displaced mass, rock) all write here, it is the
            // only way to see which of them is talking.
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
