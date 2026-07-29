// -----------------------------------------------------------------------------
// Volumetric light shafts.
//
// A shaft needs a medium, and vacuum is not one. The medium here is the nebula
// the dust field is drifting through — the same one the scene already asserts
// everywhere else: `fogDensity` is live at 0.0072 per metre, the aerial
// perspective in the terrain and particle shaders is driven off it, and the
// third shadow cascade stops at 330 m precisely because that medium has already
// eaten the contrast beyond it. So this pass is not god rays in space. It is the
// star lighting the cloud the field is sitting inside, and the dust swells
// cutting shadows through it.
//
// That distinction changes the numbers rather than the code. A nebula is thin,
// and it is *uniform along the ray* rather than piled up near the ground the way
// an atmosphere is, so a beam runs much further before it dies (`DECAY`), the
// march has to cover almost the whole path to the star rather than stopping
// short of it (`REACH`), and what comes out is proportionally far dimmer than
// air would give — see the scattering albedo in postChain.js.
//
// At a thirteen-degree star the geometry is right for it: every crest in the
// frame is a horizon-line occluder with the star sitting just above it. The same
// effect with the star overhead would be invisible, and this is written so it
// simply switches itself off there — the weight falls with the star's screen
// distance and vanishes once it leaves the frustum.
//
// Occlusion comes from the depth prepass rather than a separate occlusion render:
// a pixel where the prepass wrote nothing is sky, and sky is where the beam gets
// through. That makes this a radial integral of sky visibility, and it costs one
// texture fetch per step with no extra geometry pass behind it.
//
// Runs at quarter resolution. Shafts are the lowest-frequency thing in the frame
// by an order of magnitude, and the composite reads this back bilinearly.
// -----------------------------------------------------------------------------

#include<starPostCommon>

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

/// Where the star projects on screen, in the same UV space as everything else.
uniform sunUV: vec2f;
/// 1 when the star is in front of the camera, 0 behind. No smoothing — the
/// radial weight has already faded to nothing long before the star reaches the
/// frustum edge, so there is nothing to pop.
uniform sunOnScreen: f32;
/// The star's radiance already multiplied by what the nebula scatters out of it,
/// so this is the radiance of the *beam*, not of the source. Composed in
/// postChain.js, which is where the albedo that sets its magnitude lives.
uniform sunColor: vec3f;
uniform enabled: f32;
uniform strength: f32;
/// Aspect ratio, so the angular falloff is round on screen rather than elliptical.
uniform aspect: f32;

const STEPS: i32 = 24;
/// How far along the ray to the star the march reaches. Nearly all of it: the
/// medium is a cloud the whole field is inside, not a layer of haze lying on the
/// ground, so there is scattering material the entire way and stopping short
/// would only throw away the part of the beam closest to the source.
const REACH: f32 = 0.94;
/// Per-step attenuation. Sets how far a shaft runs before it dies out. A nebula
/// is optically thin over the couple of kilometres a frame spans — the beam is
/// bounded by geometry occluding it rather than by extinction eating it — so
/// this sits close enough to 1 that the far end of the march still carries half
/// its weight, and a shaft crossing the whole frame stays a shaft.
const DECAY: f32 = 0.975;

/// Sky visibility integrated along the ray toward the star.
fn marchShaft(uv: vec2f, pix: vec2f, radial: f32) -> f32 {
    let delta = (uniforms.sunUV - uv) * (REACH / f32(STEPS));

    // Dither the start, or twenty-four steps quantise into visible rings around
    // the star. The temporal resolve has already run by this point, so the noise
    // has to be broken up spatially rather than accumulated away — hence a fixed
    // hash rather than a per-frame one.
    var p = uv + delta * ignPost(pix);

    var illum = 1.0;
    var acc = 0.0;
    for (var i = 0; i < STEPS; i++) {
        let z = textureSampleLevel(depthTex, depthTexSampler, p, 0.0).r;
        acc += select(0.0, illum, isBackground(z));
        illum *= DECAY;
        p += delta;
    }
    acc /= f32(STEPS);

    // Squared, so a beam that is half occluded reads as clearly dimmer than one
    // that is not. Linear accumulation makes every crest emit the same haze and
    // the shafts lose their shape.
    return acc * acc * radial * uniforms.strength;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;

    // Angular weight — the phase function, standing in for one. Dust scatters
    // strongly forward, so the glow is brightest along the line to the star and
    // falls away from it; the wings are wider here than an atmosphere's because
    // the scattering volume extends the whole depth of the frame rather than
    // being a shallow layer near the ground. Still bounded well short of the
    // corner: letting it reach there turns the frame into a radial blur, which
    // is the failure mode that makes this effect look cheap.
    let d = (uv - uniforms.sunUV) * vec2f(uniforms.aspect, 1.0);
    let radial = 1.0 - smoothstep(0.03, 0.80, length(d));

    var v = 0.0;
    if (uniforms.enabled > 0.5 && uniforms.sunOnScreen > 0.5 && radial > 0.001) {
        v = marchShaft(uv, input.position.xy, radial);
    }

    fragmentOutputs.color = vec4f(uniforms.sunColor * v, 1.0);
}
