// -----------------------------------------------------------------------------
// The suit material — shared by the skinned body and the simulated soft goods.
//
// One shader has to cover everything on an astronaut, which spans woven fabric,
// composite shell, bare metal and a gold mirror. Four terms carry that range,
// and each is switched off per material slot when it does not apply:
//
//   sheen        A retroreflective lobe from the fibres standing proud of the
//                surface. It is why woven fabric has a bright *rim* rather than
//                a bright *highlight*, and it is the single term that stops the
//                soft goods reading as painted plastic. Charlie distribution,
//                which is an inverted Gaussian: energy piles up at grazing
//                angles instead of around the mirror direction.
//   anisotropy   The weave has a direction. A GGX lobe stretched along the warp
//                gives the soft directional streak real woven cloth has, and it
//                is what makes a shoulder read as a fabric plane and not as a
//                shaded cylinder.
//   transmission Thin fabric over a lit edge glows. Same back-scatter term the
//                dust uses, which is not a coincidence — it is the same physics
//                at a different mean free path.
//   metallic     A conductor takes its Fresnel reflectance from its own albedo
//                and has no diffuse lobe at all. Two lines, and without them
//                the faceplate is a surface painted gold rather than a mirror
//                made of it — which on this figure is the whole read.
//
// On top of that a procedural weave supplies a normal and a cavity at a scale
// far below the geometry, faded out by pixel footprint so it never aliases. It
// is gated on the slot's weave depth, along with the yarn slub, because a hard
// shell with a weave on it is a hard shell that reads as cloth.
//
// Everything downstream of the BRDF — cascade selection, PCSS, aerial
// perspective — is the identical code the terrain runs, from shared includes.
// The character has to sit in the same light as the field or it will look
// pasted on no matter how good the material is.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
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

/// Per material slot: rgb = albedo, a = base roughness.
uniform matAlbedo: array<vec4f, 8>;
/// Per material slot: (sheen, anisotropy, transmission, weave depth).
uniform matParams: array<vec4f, 8>;
/// Per material slot: (F0, metallic, emissive gain, unused).
uniform matExtra: array<vec4f, 8>;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;
uniform sssStrength: f32;
/// Weave threads per metre. UVs arrive in metres of surface, so this is the
/// only place the physical scale of the woven layers is decided.
uniform weaveDensity: f32;
uniform screenSize: vec2f;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<starShadowLookup>

/// Charlie sheen distribution. `roughness` here is the fibre roughness, and it
/// wants to be high — 0.3 or below turns the rim into a hard line.
fn dCharlie(NdotH: f32, roughness: f32) -> f32 {
    let invR = 1.0 / max(0.05, roughness);
    let cos2h = NdotH * NdotH;
    let sin2h = max(1.0 - cos2h, 1e-4);
    return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * PI);
}

/// Ashikhmin's visibility term — cheap, and the only one that keeps sheen
/// energy sane at grazing angles where the whole lobe lives.
fn vAshikhmin(NdotV: f32, NdotL: f32) -> f32 {
    return 1.0 / max(1e-4, 4.0 * (NdotL + NdotV - NdotL * NdotV));
}

/// Anisotropic GGX, Burley's parameterisation.
fn dGGXAniso(TdotH: f32, BdotH: f32, NdotH: f32, ax: f32, ay: f32) -> f32 {
    let a2 = ax * ay;
    let d = vec3f(ay * TdotH, ax * BdotH, a2 * NdotH);
    let d2 = dot(d, d);
    if (d2 < 1e-9) { return 0.0; }
    let b2 = a2 / d2;
    return a2 * b2 * b2 / PI;
}

/// Procedural plain weave: a tangent-space normal in xy and a cavity in z.
///
/// Warp and weft alternate which one is on top, and the one on top gets the
/// stronger ridge. That alternation is the whole read — two crossed sine
/// ridges without it look like a grid, not a textile.
fn weave(uv: vec2f) -> vec3f {
    let p = uv * 6.28318530718;
    let warp = sin(p.x);
    let weft = sin(p.y);
    let over = smoothstep(-0.35, 0.35, warp * weft);
    let nx = cos(p.x) * mix(0.30, 1.0, over);
    let ny = cos(p.y) * mix(1.0, 0.30, over);
    // Cavity is deepest where neither thread is at its crown.
    let cav = 0.55 + 0.45 * max(abs(warp), abs(weft));
    return vec3f(nx, ny, cav);
}

/// Karis' analytic split-sum environment BRDF.
///
/// Not an optimisation — a correction. Multiplying prefiltered sky radiance by
/// `fresnelSchlickRough` alone overestimates badly at grazing angles on a rough
/// surface: the roughness clamp makes the reflectance run to `1 - roughness`
/// there, which for a woven suit layer is 0.2 of the *whole sky* on every
/// silhouette pixel. The result is a surface rendering as flat pale grey
/// whenever the camera looks across it, with an albedo that had nothing to do
/// with the outcome. On a metal, where the reflection *is* the material, the
/// same error is the difference between gold and tinfoil.
fn envBRDFApprox(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = vec4f(roughness) * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    return f0 * (-1.04 * a004 + r.z) + (1.04 * a004 + r.w);
}

/// Screen-space cotangent frame. Works identically for the skinned body and the
/// Catmull-Rom soft goods, neither of which carries an authored tangent.
fn cotangentFrame(N: vec3f, dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f) -> mat3x3f {
    let dp2perp = cross(dp2, N);
    let dp1perp = cross(N, dp1);
    let T = dp2perp * duv1.x + dp1perp * duv2.x;
    let Bv = dp2perp * duv1.y + dp1perp * duv2.y;
    let invmax = inverseSqrt(max(max(dot(T, T), dot(Bv, Bv)), 1e-12));
    return mat3x3f(T * invmax, Bv * invmax, N);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Soft-goods panels are open sheets and the helmet is a shell, so the camera
    // sees both sides of nearly everything. Rather than depend on winding —
    // which for procedurally lofted geometry is one sign error away from
    // inside-out — the normal is simply turned to face the viewer. For a surface
    // this thin that is also physically the right answer.
    var N = normalize(input.vNormal);
    let twoSided = dot(N, V) < 0.0;
    if (twoSided) { N = -N; }
    let geoN = N;

    let slot = clamp(i32(input.vAux.x + 0.5), 0, 7);
    let alb4 = uniforms.matAlbedo[slot];
    let par = uniforms.matParams[slot];
    let ex = uniforms.matExtra[slot];
    var albedo = alb4.rgb;
    var roughness = alb4.a;
    let sheenAmt = par.x;
    let aniso = par.y;
    let transmit = par.z;
    let weaveDepth = par.w;
    let metallic = ex.y;
    // A dielectric keeps the slot's own F0; a conductor's reflectance *is* its
    // albedo, which is why gold reflects gold and aluminium reflects grey.
    let F0 = mix(vec3f(ex.x), albedo, metallic);

    // ------------------------------------------------------------ weave detail
    let wuv = input.vUV * uniforms.weaveDensity;
    let dp1 = dpdx(world);
    let dp2 = dpdy(world);
    let duv1 = dpdx(wuv);
    let duv2 = dpdy(wuv);
    let TBN = cotangentFrame(N, dp1, dp2, duv1, duv2);

    // Fade the weave out once a thread is under a pixel, or it aliases into a
    // crawling moire — the same footprint logic the dust's detail layers use.
    // At two hundred threads a metre this means the weave only exists in the
    // near field, which is exactly where a real one is visible.
    let uvFoot = max(length(duv1), length(duv2));
    let weaveFade = 1.0 - smoothstep(0.10, 0.45, uvFoot);
    var cavity = 1.0;
    if (weaveDepth > 0.001 && weaveFade > 0.001) {
        let w = weave(wuv);
        N = normalize(N + (TBN[0] * w.x + TBN[1] * w.y) * weaveDepth * weaveFade * 0.5);
        cavity = mix(1.0, w.z, weaveFade * 0.8);
    }

    // Slub: real yarn is not uniform, and a little variation in the base tone
    // does more for "this is a woven thing" than another specular term. Runs at
    // centimetre scale, an order of magnitude coarser than the weave, so unlike
    // the weave it survives to the distance the figure is actually seen at.
    //
    // Gated on the same weave depth the weave itself is. A moulded shell, a
    // bearing and a faceplate have no yarn in them, and a centimetre-scale
    // albedo wobble is exactly what stops a mirror looking machined.
    if (weaveDepth > 0.001) {
        let slub = noise2(input.vUV * vec2f(9.0, 26.0)) * 0.5 + 0.5;
        albedo *= 0.90 + 0.20 * slub;
        roughness = clamp(roughness * (0.94 + 0.12 * slub), 0.05, 1.0);
    }

    // Baked at the vertex, times the weave cavity. No screen-space occlusion:
    // it is a two-metre silhouette against forty metres of dust, and the pass
    // does not pay for itself on this content.
    var ao = input.vAux.y * cavity;

    // ------------------------------------------------------------- lighting
    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let noiseRot = ign(input.position.xy) * 6.28318530718;

    var shadow = 1.0;
    if (NdotL > -0.4) {
        shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);
    }

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // --- diffuse -----------------------------------------------------------
    // Wrapped by however woven the slot is. The wrap stands in for scatter
    // between fibres, so it belongs to fabric and to nothing else: the
    // terminator on a sleeve is genuinely soft, the one on a moulded shell is
    // genuinely not, and running a fabric terminator across the helmet is what
    // would make the hard parts read as upholstery.
    let diff = wrapDiffuse(NdotL, mix(0.05, 0.18, clamp(weaveDepth, 0.0, 1.0)));
    var color = albedo * INV_PI * sun * diff * shadow * (1.0 - metallic);

    // --- transmission through thin cloth -----------------------------------
    if (transmit > 0.001) {
        let back = backScatter(N, L, V, 0.4, 4.0, 1.0);
        color += sun * albedo * back * transmit * uniforms.sssStrength
               * mix(0.35, 1.0, shadow);
    }

    // --- specular: anisotropic weave ---------------------------------------
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let NdotH = clamp(dot(N, H), 0.0, 1.0);
        let VdotH = clamp(dot(V, H), 0.0, 1.0);

        let ar = max(0.04, roughness * roughness);
        let ax = ar * (1.0 + aniso);
        let ay = ar / (1.0 + aniso);
        let D = dGGXAniso(dot(TBN[0], H), dot(TBN[1], H), NdotH, ax, ay);
        let Vis = visSmithGGXCorrelated(NdotV, max(NdotL, 1e-4), roughness);
        let F = fresnelSchlick(VdotH, F0);
        color += sun * D * Vis * F * NdotL * shadow;

        // --- sheen ---------------------------------------------------------
        // Tinted toward the albedo but desaturated: fibre scatter is closer to
        // white than the bulk colour, which is why a dark panel rims pale.
        //
        // Two corrections, both learned by looking at the render rather than at
        // the paper. First, the Ashikhmin visibility term runs away when both
        // cosines are small, so the lobe is clamped. Second — and this is the
        // one that mattered — Charlie is an *inverted* distribution: it is near
        // its peak everywhere except close to the mirror direction, so applied
        // flat it is not a rim, it is a uniform veil over the whole surface. At
        // full strength it lifted the soft goods to the same value as the field
        // behind them and erased the silhouette completely.
        //
        // The grazing gate puts the energy back where fibre scatter actually
        // shows: the edge, where the line of sight passes along the pile rather
        // than into it.
        let sheenTint = mix(vec3f(1.0), normalize(albedo + 1e-4), 0.35);
        let ds = dCharlie(NdotH, 0.42);
        let graze = 0.16 + 0.84 * pow(1.0 - NdotV, 2.0);
        let sheenLobe = min(ds * vAshikhmin(NdotV, max(NdotL, 1e-4)) * NdotL, 0.25);
        color += sun * sheenTint * sheenLobe * graze * sheenAmt * shadow;
    }

    // --- ambient ------------------------------------------------------------
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    // Near-field bounce off the dust the figure is standing on.
    //
    // The sky LUT's lower hemisphere already carries the sea's solved radiance
    // and `shIrradiance(N)` integrates the whole sphere, so the sea is mostly
    // accounted for above. What is not is the few metres directly underfoot —
    // the groove the board just cut and the mass it just threw, both of which
    // emit in their own right and neither of which nine SH coefficients can
    // resolve. That is a real source and it is close, which is why this is not
    // an albedo-weighted reflection: a glowing sea sends up far more than its
    // eight per cent reflectance would.
    //
    // Sampled downward and weighted onto downward-facing normals, because that
    // is where light from below actually lands: the underside of the pack, the
    // chin of the helmet, the boots and the deck. Same direction and same
    // coefficient as the field and the far range use, so the astronaut is lit
    // from below by exactly what the dunes are.
    let bounceUp = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3f(0.0, -1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.25 * bounceUp;

    color += albedo * INV_PI * irradiance * ao * (1.0 - metallic);

    // Ambient sheen: the sky wrapping around a fuzzy silhouette. Cheap, and it
    // is most of what reads as "fuzz" when the sun is behind the figure. Kept
    // deliberately small — this term is albedo-independent, so any generosity
    // here erases the difference between a dark panel and a white one.
    let rim = pow(1.0 - NdotV, 4.0);
    let skyAmb = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI;
    color += skyAmb * rim * sheenAmt * 0.55 * ao;

    // Ambient specular from the sky at a roughness-selected mip.
    //
    // The exponent is 0.75 rather than the 0.5 a fabric-only material wanted.
    // A square root biases hard toward blurry — at the faceplate's roughness of
    // 0.055 it still picks mip 1.4, which smears the galactic band into a
    // gradient and throws away the only thing on the character that is supposed
    // to be a mirror. At 0.75 the same surface lands near mip 0.7, where the
    // 512x256 LUT still resolves the band's dust lanes and the edges of the
    // emission nebulae, while a rough one is barely moved. Point stars are not
    // among what it can reflect — they are drawn in the skybox and never enter
    // the bake — so what makes the faceplate read as a mirror is the structure
    // in the band, and that structure only survives at a low mip.
    let R = reflect(-V, N);
    let mip = pow(roughness, 0.75) * 6.0;
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), mip).rgb;
    color += skyRefl * envBRDFApprox(F0, roughness, NdotV)
           * uniforms.ambientIntensity * ao;

    // --- spell light --------------------------------------------------------
    // The caster is standing inside the thing they are casting, so this is the
    // one material where the spell lights are almost always the *dominant*
    // source: a 13-degree sun is behind the figure for most of the framing this
    // demo uses, and a suit lit only by a space sky's ambient is a silhouette.
    // Something bright held at arm's length is what puts light back on the front
    // of it.
    //
    // Wrapped harder than the sun's diffuse, because at half a metre the light
    // is a broad source rather than a point, and thin fabric over a bright
    // emitter genuinely does carry light around the fold.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, albedo * (1.0 - metallic), F0, roughness, 0.35,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        ) * ao;
    }

    // --- emission -----------------------------------------------------------
    // The light strips and the faceplate's own glow. Multiplying the slot's
    // albedo means an emitter can never disagree with its own colour, and it is
    // deliberately not multiplied by occlusion: a lamp in a crevice is not a
    // dimmer lamp. Added before the aerial pass, so a strip a hundred metres out
    // fogs like everything else rather than punching through.
    if (ex.z > 0.001) {
        color += albedo * ex.z;
    }

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, 1.0);
}
