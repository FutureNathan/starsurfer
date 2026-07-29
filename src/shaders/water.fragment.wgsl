// -----------------------------------------------------------------------------
// The powers' plasma bodies — shading.
//
// Four of the five powers move a coherent body of dust that has been *ignited*,
// and this is the material all four are drawn with. It is the one surface in the
// demo whose colour is mostly its own: everything else out here is dust
// reflecting a small distant star, and this is dust that is generating light.
//
// Four things have to be true at once or it reads as a coloured plastic tube:
//
//   it emits                A power is a source, not a reflector. At an albedo
//                           of nine percent under one small star and a sky that
//                           is the void, a body that only reflected would be a
//                           dark shape moving across a dark field. Everything
//                           else here is a modifier on this one term.
//   it is a volume,
//   not a shell             The emission is solved as a slab of emitting,
//                           absorbing medium, so the radiance saturates with the
//                           chord the eye cuts through it. A grazing view cuts
//                           the longest chord, so the silhouette is the brightest
//                           part of the body without a rim term anywhere, and a
//                           thin trailing wisp genuinely fades out instead of
//                           being faded out.
//   you can see through it  Not much, and less the thicker it is — but the
//                           galactic band showing through the top of a stream and
//                           the dust sea showing through its belly is most of
//                           what says it is made of light rather than of plastic.
//   it carries matter       Every one of these bodies tore itself out of the
//                           ground, and the Gravity Well is almost entirely
//                           lifted dust. That population scatters the star,
//                           answers the other powers' lights, and sparkles — and
//                           it is what keeps the Well reading as mass while the
//                           Ion Stream reads as light.
//
// **Refraction and emission — which one is carrying the frame.** The obvious way
// to shade a transparent body is by what it *subtracts*: absorption over a path,
// against a bright backdrop sampled along a refracted ray. Neither half of that
// earns its place here. There is no bright backdrop — the sky is the void, so
// there is almost nothing to subtract from — and a plasma's refractive index is a
// hair *under* one, because the free electrons push the phase velocity past c. It
// bends a ray by about a degree where water would bend it by twenty. So the
// balance sits decisively on the other side: refraction survives as a minority
// term that tints the body with whatever is behind it, and the emission is the
// material.
//
// This is the reason the absorption coefficients here are not an absorption
// spectrum in the usual sense. They are read through Kirchhoff, as the emission
// spectrum of a medium in local equilibrium — what the body *takes out* of the
// backdrop and what it *puts in* of its own are one number, and the second is by
// far the larger.
//
// What refraction is still worth keeping, and why the LUT lookup is still the
// right way to get it: the sky LUT stores both the galaxy above the horizon and
// the iteratively-solved radiance of the dust sea below it, so one sample along
// the refracted ray is a physically-derived estimate of what is behind the body
// in *any* direction, at the cost of one texture fetch and with no scene copy,
// no mid-frame render-target read, and nothing to re-order against the
// transparent pass. Three fetches at three indices give the dispersion, and in a
// plasma that dispersion is not a subtlety — the index depends on the plasma
// frequency over the light's own frequency, so red bends hardest and reaches its
// total-internal-reflection angle four degrees before blue does. The rim of a
// body therefore fringes, for exactly the reason a real one would.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vU: f32;
varying vRadius: f32;
varying vFront: f32;
varying vDust: f32;
varying vAlpha: f32;
varying vEmissive: vec3f;
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
uniform waterTime: f32;
/// Artistic scale on the medium's opacity. One slider for "how deep does this
/// body read", which is the single most-tuned number in the material — it
/// decides whether a stream is a bright filament or a solid bar of light.
uniform waterDepthTint: f32;
/// The hue the ignition front runs to, straight off the brand palette's `star`.
/// Set once: it is the same white for every power, because past a certain
/// temperature everything is the same white.
uniform frontColor: vec3f;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<starShadowLookup>

/// Extinction per metre through the ignited medium itself.
///
/// An optical depth of one over about a quarter of a metre — thick for an
/// ionised gas, and it should be: this is not clean plasma, it is a dust sea
/// that has been lit, so what stops the light is the grain population the
/// ionisation front is dragging with it.
///
/// The number that matters is the ratio to the bodies' actual sizes. A stream is
/// 20 cm through and a Supernova column over a metre, so at this coefficient the
/// stream saturates to roughly three quarters of its own emission and the column
/// saturates completely — which is the difference between a filament of light and
/// a solid mass of it, and it falls out of the geometry rather than being dialled
/// per power.
const PLASMA_EXTINCT: f32 = 4.2;

/// Extinction added per unit of entrained, *unignited* dust.
///
/// Five times the plasma's, because this is the one component that is genuinely
/// opaque: a few centimetres of packed grains stops everything. It is what makes
/// the Gravity Well's helices read as lifted matter with light in them rather
/// than as luminous tubes, without a second material or a second code path.
const DUST_EXTINCT: f32 = 22.0;

/// Reflectance of the dust a power is carrying.
///
/// Not a free choice, and not a colour picked to look right. It is the value the
/// dust field's own deformation berm resolves to, and the value the wake's wall
/// uses — because a power that has just torn a channel out of the ground is
/// throwing the same freshly broken grains the board throws, and the two are
/// often touching. Any disagreement here draws a seam between the crescent and
/// the berm it is ploughing, which is the most artificial thing this surface can
/// do.
///
/// The magnitude is as load-bearing as the hue. The star's radiance is set so
/// that a nine-percent surface lands near linear 5, which means *any* reflectance
/// in this material is read against 0.085 rather than against unity: a value up
/// near 0.9 does not render as bright ejecta, it renders at ten times the
/// brightness of the ground and clips to flat white.
const EJECTA_ALBEDO: vec3f = vec3f(0.124, 0.091, 0.216);

/// Normal-incidence reflectance of the boundary.
///
/// Essentially nothing, and that is the physics rather than a preference. The
/// edge of a plasma is a density *gradient* tens of centimetres deep, not an
/// interface — and a graded index has no Fresnel reflection at all, which is the
/// entire principle an anti-reflection coating works on. What the body does have
/// is the grain population inside it, whose facets are ordinary dielectrics, so
/// the reflectance is interpolated up to the dust field's own 0.020 with the
/// entrained fraction.
const PLASMA_F0: f32 = 0.0006;
const DUST_F0: f32 = 0.020;

/// Ceiling on the Fresnel mirror at grazing.
///
/// Every interface returns everything at ninety degrees, graded or not, so the
/// Schlick term still runs to one at the silhouette. Out here that reflects the
/// void — so left uncapped it would *delete* the rim, which is the one part of
/// the body the eye reads the material from and the brightest part of the
/// emission. A tenth is what a boundary this soft is entitled to.
const FRESNEL_CAP: f32 = 0.12;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    if (input.vAlpha <= 0.003 || input.vRadius <= 0.0005) { discard; }

    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Both faces of the body are visible — it is transparent, and the sheet
    // profile is genuinely open — so winding says nothing. Turn the normal
    // toward the eye, exactly as the wake and the garments do.
    let Ng = normalize(input.vNormal);
    var N = select(-Ng, Ng, dot(Ng, V) >= 0.0);
    let geoN = N;

    // Flow-map ripple. Two counter-drifting octaves sliced along two oblique
    // world directions rather than the XZ plane: the body is as often vertical
    // as horizontal, and a planar lookup bands it into horizontal stripes on the
    // vertical parts — the one pattern that reads as a rendering error.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    let fp = vec2f(
        dot(world, vec3f(0.88, 0.31, -0.36)),
        dot(world, vec3f(0.24, 0.79, 0.56))
    );

    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
    let T = normalize(cross(up, N));
    let B = cross(N, T);

    //
    // This is where *all* of the fine surface detail lives, and it has to be:
    // the mesh is 176 columns by 24 rings whatever the strand is doing, so
    // anything finer than that in the geometry is not detail, it is aliasing.
    // See the note on `waterRelief`. Here the sampling rate is the pixel, so
    // three octaves are affordable and the footprint fade keeps each of them
    // switched off before it can shimmer.
    let t = uniforms.waterTime;
    let rippleFade = 1.0 - smoothstep(0.03, 0.22, footprint);
    if (rippleFade > 0.002) {
        let g1 = noised(fp * 8.5 + vec2f(t * 0.7, -t * 0.5));
        let g2 = noised(fp * 21.0 + vec2f(-t * 1.6, t * 1.1));
        N = normalize(N + (T * (g1.y * 0.085 + g2.y * 0.055)
                         + B * (g1.z * 0.085 + g2.z * 0.055)) * rippleFade);
    }
    let fineFade = 1.0 - smoothstep(0.006, 0.045, footprint);
    if (fineFade > 0.002) {
        let g3 = noised(fp * 62.0 + vec2f(t * 3.1, t * 2.2));
        N = normalize(N + (T * g3.y + B * g3.z) * 0.030 * fineFade);
    }

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- what this body is made of ----------------------------------------
    // `vEmissive` is the power's normalised hue times its peak radiance, so its
    // largest channel *is* the gain and dividing by that recovers the hue. One
    // interpolant carries both, and nothing downstream has to know which power
    // it is drawing.
    let emitR = input.vEmissive;
    let peak = max(max(emitR.r, emitR.g), max(emitR.b, 1e-4));
    let hue = emitR / peak;

    // ---- how far the light travelled through the body ---------------------
    // Grazing views cut a long chord, head-on views a short one. That single
    // relationship is most of what makes a tube look like a volume rather than
    // like a shell: the silhouette is always the deepest part of it, so it is
    // both the most saturated and — once the medium emits — the brightest.
    //
    // The constant term matters as much as the grazing one. Keying the path
    // purely off view angle puts *all* of the body at the silhouette, and a
    // 30 cm stream that is only luminous at its own edge is an outline rather
    // than a mass. Giving the path a floor proportional to the radius means a
    // fat body is lit all the way across it.
    let path = clamp(
        input.vRadius * (1.25 + 1.9 * (1.0 - NdotV)),
        0.01, 3.0
    );

    // Kirchhoff's law, and it is doing real work rather than decorating the
    // maths: a medium in local equilibrium absorbs in exactly the bands it emits
    // in. So the extinction spectrum *is* the emission spectrum, and every power
    // gets a depth-dependent hue for free — the channel it emits hardest in is
    // also the one that saturates first, so a thin edge of a body is the most
    // saturated part of it and the belly runs to the full source colour.
    //
    // Interpolated toward flat grey rather than run to the pure hue, because a
    // channel with no extinction has no emission either, and a Gravity Well
    // whose red went to zero would show the scene straight through itself in red
    // alone — a chromatic hole, which is not what a dim violet body looks like.
    let extinct = (PLASMA_EXTINCT * mix(vec3f(1.0), hue, 0.70)
                 + vec3f(DUST_EXTINCT * input.vDust)) * uniforms.waterDepthTint;
    let transmit = exp(-extinct * path);

    // ---- refraction, with dispersion --------------------------------------
    // Indices *below* one, which is the single most characteristic optical fact
    // about a plasma: the free electrons make the phase velocity exceed c, so
    // n = sqrt(1 - (wp/w)^2) and the medium is optically thinner than vacuum. The
    // ray bends the other way and by about a degree rather than by twenty.
    //
    // Dispersion is strong and its ordering is the reverse of glass — the closer
    // the light's frequency gets to the plasma frequency the further n falls, so
    // red is bent hardest. Below n the ray is totally internally reflected, so
    // red goes to mirror around seventy-six degrees from the normal and blue
    // holds out to eighty: four degrees of the rim where the body reflects in one
    // channel and refracts in the others. That is the fringe, and it is free.
    let rr = refract(-V, N, 1.0 / 0.9720);
    let rg = refract(-V, N, 1.0 / 0.9800);
    let rb = refract(-V, N, 1.0 / 0.9860);
    // Total internal reflection returns a zero vector; fall back to the mirror
    // direction there, which is what actually happens.
    let mirror = reflect(-V, N);
    let dr = select(mirror, rr, dot(rr, rr) > 0.5);
    let dg = select(mirror, rg, dot(rg, rg) > 0.5);
    let db = select(mirror, rb, dot(rb, rb) > 0.5);

    // A low mip, because a body that barely bends a ray barely scatters one
    // either — what comes through a plasma is close to what is behind it. Not
    // mirror-sharp: the surface carries three octaves of ripple, and the mip is
    // what stops those aliasing the backdrop.
    let behind = vec3f(
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dr), 1.0).r,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dg), 1.0).g,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(db), 1.0).b
    );
    var color = behind * transmit;

    // ---- starlight scattered inside the body -------------------------------
    // Light from the star that entered the body, bounced off the grains it is
    // carrying, and came back out toward the eye. Peaks looking into the star
    // through the thin parts, so an arc lights up from the inside where the star
    // is behind it.
    //
    // Tinted by the dust doing the scattering, and brightened where the body is
    // thin because less of it is absorbed on the way back out — violet at depth,
    // near-neutral at the edges, for free.
    //
    // The 1/PI is not decoration. A scattering lobe is a *distribution*, and
    // multiplying radiance by one without the 1/PI that belongs in front of it
    // overstates the peak by a factor of three — which on a term already fed by
    // a 231:190:139 star put this several times brighter than lit dust. The body
    // clipped to flat white along its whole length and no amount of tinting
    // underneath could show through it. Exactly the failure the grains' forward
    // scatter had, for exactly the same reason.
    let inScatter = backScatter(N, L, V, 0.55, 2.6, 1.0);
    let scatterTint = EJECTA_ALBEDO * mix(vec3f(1.0), vec3f(1.55, 1.85, 1.05), exp(-path * 1.6));
    color += sun * INV_PI * scatterTint * inScatter
           * (0.55 + 1.3 * input.vDust) * uniforms.sssStrength
           * mix(0.30, 1.0, shadow);

    // Sky filling the body. Out here that is mostly the dust sea from below
    // rather than a dome from above — the LUT's lower hemisphere holds the sea's
    // solved radiance and the SH is projected over the whole sphere of it, so a
    // downward-facing patch already collects it. Without this the shadowed side
    // of an arc has nothing in it but the refraction, and goes dead.
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
           * scatterTint * (0.35 + 0.5 * input.vDust);

    // ---- entrained dust ----------------------------------------------------
    // What a power dials to move between clear plasma and the mass it tore out
    // of the ground on the way up. It is not a colour: it is an opaque diffuse
    // population *inside* the body, so it fills in behind the transparency
    // rather than tinting it, and the two coexist the way lifted dust really
    // does. The Gravity Well sits at 0.88 and is very nearly all of this.
    if (input.vDust > 0.002) {
        let d = wrapDiffuse(NdotL, 0.62);
        var lifted = EJECTA_ALBEDO * INV_PI * sun * d * shadow;
        lifted += EJECTA_ALBEDO * INV_PI * shIrradiance(N, uniforms.shR)
                * uniforms.ambientIntensity;
        lifted += dustSubsurface(N, L, V, sun, 0.45, uniforms.sssStrength * 0.8, 1.2)
                * EJECTA_ALBEDO * mix(0.35, 1.0, shadow);
        color = mix(color, lifted, input.vDust * 0.85);
    }

    // ---- the ignition front ------------------------------------------------
    // The leading edge, where the body is tearing itself apart against the
    // ground and the grains are being broken and lit. Broken up by a drifting
    // noise so it is a ragged front rather than a painted band.
    //
    // The *reflective* half of it is the same loose dust as the rest of the
    // body — freshly broken grains are not a different substance, they are the
    // same substance hotter. Everything that separates the front from the body
    // it is running ahead of is in the emission, at the bottom of the shader.
    // That is the wake's own construction, and it is what stops a front becoming
    // a white line pasted along the leading edge.
    var front = input.vFront;
    if (front > 0.002) {
        let fn2 = noise2(fp * 22.0 + vec2f(t * 1.7, -t * 1.1)) * 0.5 + 0.5;
        let fn3 = noise2(fp * 61.0 - vec2f(t * 3.3, t * 2.1)) * 0.5 + 0.5;
        front = clamp(front * (0.35 + 1.5 * fn2 * (0.5 + 0.7 * fn3)), 0.0, 1.0);
        var fc = EJECTA_ALBEDO * INV_PI * sun * wrapDiffuse(NdotL, 0.72) * shadow;
        fc += EJECTA_ALBEDO * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
        fc += dustSubsurface(N, L, V, sun, 0.25, uniforms.sssStrength, 1.4)
            * EJECTA_ALBEDO * mix(0.4, 1.0, shadow);
        color = mix(color, fc, front);
    }

    // ---- reflection --------------------------------------------------------
    // Applied after the body terms because it sits *on* the boundary: what it
    // returns never went through the medium and is therefore never tinted by it.
    //
    // A minority term, and deliberately so on two counts: a graded plasma
    // boundary has almost no reflectance, and there is almost nothing above the
    // horizon out here to reflect. See `FRESNEL_CAP`.
    //
    // The entrained fraction has to take the *surface* out as well as filling
    // the body in. A cloud of grains in vacuum has no coherent mirror at all,
    // however polished each individual grain is, and a Gravity Well that
    // returned a third of the sky at grazing came out looking like moulded
    // plastic: opaque, which was right, and polished, which was not.
    let f0 = vec3f(mix(PLASMA_F0, DUST_F0, input.vDust));
    let F = min(fresnelSchlick(NdotV, f0), vec3f(FRESNEL_CAP));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), 0.7).rgb;
    color = mix(color, skyRefl, F * (1.0 - front * 0.7) * (1.0 - input.vDust * 0.88));

    // The star's own highlight. Tight where the boundary is smooth, broad where
    // the body is packed with grains — and small either way, because the
    // reflectance it is driven by is.
    let rough = mix(0.055, 0.68, max(front * 0.55, input.vDust));
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), f0);
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    // Individual grains on the outer skin catching the star as points. The dust
    // field's own glint field, at a much finer cell and gated the same way, so
    // the sparkle on a power and the sparkle on the ground are the same effect.
    //
    // Gated hard on how much dust the body is actually carrying. A mirror facet
    // returns the source radiance whatever the albedo around it is, so under a
    // star this bright a glint is far brighter than the surface it sits on —
    // which is right for the Gravity Well's helices full of lifted grains, and
    // completely wrong for a clear Ion Stream, which has no facets to do it
    // with.
    if (uniforms.glintIntensity > 0.001) {
        let g = dustGlints(
            fp, N, V, L, footprint,
            uniforms.glintIntensity * (0.15 + 1.1 * max(front * 0.6, input.vDust)),
            uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.7;
    }

    // ---- another power's light ---------------------------------------------
    // What answers it is the dust the body is carrying, not the plasma — light
    // passes through plasma, it does not bounce off it. So the response runs
    // from a fraction of the ejecta albedo on a clear stream to all of it on a
    // Well full of lifted mass.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, EJECTA_ALBEDO * mix(0.35, 1.0, input.vDust),
            f0, rough, 0.55,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- the body's own light ----------------------------------------------
    //
    // The solution for a uniform slab that both emits and absorbs: what leaves
    // it is the background attenuated plus the source function weighted by how
    // much of the slab the eye is looking through. `behind * transmit` at the top
    // of the shader is the first half of that equation and this is the second,
    // and out here the second half is nearly all of it — the background is the
    // void, so a material carrying only the attenuation term would be a dark
    // shape moving across a dark field.
    //
    // Nothing about it is a rim term, and that is the point of doing it this way:
    // the silhouette comes out brightest because the chord through it is longest,
    // a thin trailing wisp dims because there is less of it to emit, and the two
    // fall out of one exponential rather than out of two hand-fitted curves.
    //
    // The front runs hotter and whiter. One material at two temperatures, so
    // *both* halves of that are interpolations and neither is a sum. The hue
    // mixes toward starlight, because adding white on top of gold gives white and
    // that is the one colour this palette exists to avoid; the white fraction
    // goes as the front squared so it stays on the leading edge instead of
    // washing the body pale, since an accent has to be scarce to stay an accent.
    //
    // The gain interpolates the same way, over the same parameter, and — this is
    // the part that has to hold — it interpolates *up to* the power's gain rather
    // than past it. `POWERS[*].body` is defined as the peak radiance of the body,
    // and every one of those five numbers is argued against three measured
    // quantities: the wake's crest at 10, lit dust near 5, and the bloom knee at
    // 3.0. A multiplier above one here would silently move the material off all
    // three, so the ignition front reaches the stated peak and the body behind it
    // sits at 0.60 of it. That is the wake's own ratio between its lip and its
    // wall, for the identical reason: the crest is the freshest, hottest mass and
    // everything trailing it has already begun to cool.
    //
    // Added last, and deliberately exempt from the reflection and the entrained
    // dust above it: a body full of light must not be dimmed by being full of
    // dust as well. It still hazes out with distance like everything else, or a
    // power cast forty metres away is a flat bright shape pasted in front of the
    // sky.
    let hot = front * front;
    let source = mix(emitR, uniforms.frontColor * peak, hot * 0.60);
    color += source * (vec3f(1.0) - transmit) * mix(0.60, 1.0, front);

    // ---- opacity -----------------------------------------------------------
    //
    // Nearly opaque, which is the opposite of the obvious answer for something
    // made of light and is the single thing that keeps the compositing honest.
    //
    // Running the alpha off Fresnel — transparent face-on, mirror at grazing —
    // counts the background *twice*: once through the refracted lookup, which is
    // the physically-placed, dispersed, attenuated version of it, and again
    // through the blend, which is the undistorted version at full brightness.
    // Over a glowing dust sea the second one wins. A high alpha deletes the
    // duplicate and leaves the refraction as the only path the background takes
    // through the body — which is also the only reason the slab solution above
    // is allowed to claim it is the whole answer.
    //
    // What is left for the alpha to do is the ends. The radius tapers to nothing
    // there, so keying opacity to the radius closes a tube on a soft point rather
    // than on a ring of visible section. That is also why nothing fades in `u`:
    // `u` means "along the spine" and cannot tell a stream's trailing wisp from
    // the symmetric horn of a crescent.
    let taper = clamp(input.vRadius / 0.055, 0.0, 1.0);
    let clearAlpha = taper * mix(0.74, 0.97, 1.0 - NdotV);
    let alpha = mix(clearAlpha, taper, max(front, input.vDust * 0.9)) * input.vAlpha;
    if (alpha < 0.004) { discard; }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
