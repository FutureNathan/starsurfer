// -----------------------------------------------------------------------------
// The composite: shafts, bloom, exposure, the display transform, grain.
//
// Everything that has to happen in one place happens here, because each of these
// is defined relative to the one before it. Shafts are radiance and go in before
// exposure; bloom arrives already thresholded on *scene* radiance, so the mix
// here is the only place its weight is decided; contrast is applied in linear so
// it pushes into the tone curve's shoulder rather than clipping after it; grain
// goes on after the encode so it reads evenly across the range instead of
// vanishing in the shadows.
//
// A space render dies at the tonemapper, and it dies at both ends at once. The
// frame is mostly void — a near-black field with a handful of very bright, very
// *saturated* emitters standing in it — so the range the curve has to cover runs
// from empty sky at a thousandth of middle grey to a star disc three orders of
// magnitude above it. A curve with a short shoulder clips the star, the wake and
// the galactic band to the same white, and every one of them is a different
// colour; a curve with a short toe swallows the nebula whole.
//
// AgX is the default here rather than ACES for exactly that reason: its shoulder
// is long enough that dust lit to five times its own resting glow, a wake crest
// at twice that again, and the star above both still resolve as three separate
// values. What it costs is chroma — AgX desaturates toward white as it climbs —
// and in this scene the chroma lives *in* the highlights rather than below them,
// which is why the saturation is pushed back up harder here than a daylight
// scene would want. ACES is offered for comparison and does visibly worse: its
// notorious hue skew turns the nebula's magenta orange well before it clips.
// -----------------------------------------------------------------------------

varying vUV: vec2f;

#include<starPostCommon>

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;

/// The prepass, for one bit: is this pixel sky. The speed streaks read it and
/// nothing else here does.
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;
/// Quarter-resolution bright pass — the tight halo around a grain or the star.
var bloomNear: texture_2d<f32>;
var bloomNearSampler: sampler;
/// Sixteenth-resolution, blurred — the broad lobe of the same glare.
var bloomFar: texture_2d<f32>;
var bloomFarSampler: sampler;
var shaftsTex: texture_2d<f32>;
var shaftsTexSampler: sampler;

uniform exposure: f32;
uniform contrast: f32;
uniform mode: f32;       // 0 = AgX, 1 = ACES, 2 = none
uniform grainAmount: f32;
uniform time: f32;
uniform vignette: f32;
/// 0 = standing still, 1 = flat out on a surf run. Drives the speed streaks.
uniform speedStreak: f32;
uniform bloomAmount: f32;
uniform shaftAmount: f32;

// ------------------------------------------------------------------ AgX

const AGX_IN = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
);

const AGX_OUT = mat3x3f(
     1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
);

/// Sixth-order fit of the AgX contrast curve.
fn agxContrast(x: vec3f) -> vec3f {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2
         - 40.14 * x4 * x
         + 31.96 * x4
         - 6.868 * x2 * x
         + 0.4298 * x2
         + 0.1191 * x
         - 0.00232;
}

fn agx(color: vec3f) -> vec3f {
    const MIN_EV: f32 = -12.47393;
    const MAX_EV: f32 = 4.026069;

    var v = AGX_IN * max(color, vec3f(0.0));
    v = clamp(log2(max(v, vec3f(1e-10))), vec3f(MIN_EV), vec3f(MAX_EV));
    v = (v - MIN_EV) / (MAX_EV - MIN_EV);
    return agxContrast(v);
}

/// Saturation recovery. AgX deliberately desaturates highlights; without some of
/// it back, the violet-shadow / gold-light split the whole look rests on gets
/// flattened out along with the clipping it was there to prevent.
fn agxLook(color: vec3f, sat: f32) -> vec3f {
    let lw = vec3f(0.2126, 0.7152, 0.0722);
    let l = dot(color, lw);
    return max(vec3f(0.0), l + (color - l) * sat);
}

// ------------------------------------------------------------------ ACES

fn acesFitted(x: vec3f) -> vec3f {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

// -----------------------------------------------------------------------------

fn linearToSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

// ------------------------------------------------------------ speed streaks
//
// Two effects, both gated on the same value and both confined to the periphery,
// because that is where speed is actually read: the centre of the frame is what
// the player is looking at and blurring it just makes the demo feel broken.
//
//   radial smear    six taps drawn toward the focus. This is the one that does
//                   the work — it is the only thing in the chain that makes the
//                   *scene* look fast rather than decorating it.
//   stardust        sparse radial strands of lit dust tearing past the faceplate,
//                   phase-advanced with time so they stream outward.
//
// Both are applied before the tonemapper so its shoulder rolls the strands off
// rather than letting them clip, and both cost nothing at all when the player is
// not moving — `speedStreak` is zero and the whole block is skipped.

/// Starlight white, linear. `LIN.star` in src/core/brand.js — the same hue the
/// wake's thrown grains carry, because this is the same material passing closer.
const STRAND_TINT = vec3f(1.0, 0.921582, 0.745404);

/// Peak radiance of a strand, on the scene's own linear scale.
///
/// Derived from the grains rather than dialled in. A grain thrown clear of the
/// wake carries `EMIT.grain` — fourteen times starlight white — and a strand is
/// one of those smeared along the path it crosses the frame on. A smear
/// conserves energy, so the peak drops by the ratio of the dash to the grain,
/// and the dashes here run about ten grain-widths, which lands at 1.4. Just over
/// middle grey once exposed: bright enough to read as something lit rather than
/// as grey lint on the periphery, far enough below the wake it came off that the
/// shoulder still has room for both.
const STRAND_RADIANCE: f32 = 1.4;

fn streakStrands(d: vec2f, r: f32, t: f32) -> f32 {
    let ang = atan2(d.y, d.x);
    let a = ang * 96.0;
    let cell = floor(a);
    let rnd = fract(sin(cell * 12.9898 + 4.1) * 43758.5453);
    // Only a fraction of the angular cells carry a strand; a strand in every one
    // reads as a zoom-blur artefact rather than as passing dust.
    if (rnd > 0.34) { return 0.0; }

    let across = abs(fract(a) - 0.5) * 2.0;
    // The radial frequency is the number that decides whether this reads as
    // dust going past or as scratches on the faceplate. At one cycle across the
    // frame a strand is a straight line from the centre to the corner; at
    // fourteen it is a two-centimetre dash, which is what a grain crossing the
    // frame in a fifteenth of a second actually looks like.
    let phase = fract(r * (11.0 + rnd * 24.0) - t * (7.0 + rnd * 22.0));
    let seg = smoothstep(0.55, 0.86, phase) * (1.0 - smoothstep(0.86, 1.0, phase));
    return pow(1.0 - across, 20.0) * seg;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var c = textureSample(textureSampler, textureSamplerSampler, input.vUV).rgb;

    // Radial smear, on the scene radiance before exposure — and on the *world*
    // only. The streaks are motion: dust and ground rushing past a rider doing
    // twenty metres a second. The stars are not moving — they are light-years
    // away, and a star field smeared into radial lines is a warp-jump effect on
    // a scene whose whole premise is standing still under a fixed sky. So a
    // pixel the prepass calls background keeps its exact radiance: the ground
    // blurs with speed, the sky holds.
    let sceneZ = textureSampleLevel(depthTex, depthTexSampler, input.vUV, 0.0).r;
    let onSky = isBackground(sceneZ);
    let dFocus = input.vUV - vec2f(0.5, 0.5);
    let radius = length(dFocus) * 2.0;
    let streak = uniforms.speedStreak * smoothstep(0.34, 1.05, radius)
               * select(1.0, 0.0, onSky);
    if (streak > 0.002) {
        var acc = c;
        for (var i = 1; i <= 6; i++) {
            let t = f32(i) / 6.0 * streak * 0.026;
            // textureSampleLevel, not textureSample: this loop sits under a
            // non-uniform branch, where implicit derivatives are undefined.
            acc += textureSampleLevel(
                textureSampler, textureSamplerSampler, input.vUV - dFocus * t, 0.0
            ).rgb;
        }
        c = mix(c, acc / 7.0, 0.88);
    }

    // Light shafts, in scene radiance so the tone curve rolls them off with
    // everything else. Added rather than blended: a shaft is light arriving at
    // the lens along a path, not a surface that replaces what is behind it.
    if (uniforms.shaftAmount > 0.0001) {
        c += textureSampleLevel(shaftsTex, shaftsTexSampler, input.vUV, 0.0).rgb
           * uniforms.shaftAmount;
    }

    c *= uniforms.exposure;

    // Bloom. Both levels were thresholded on *scene* radiance, before exposure —
    // see the knee in postChain.js — so they arrive on the same scale `c` was on
    // a line ago and have to be exposed with it. Multiplying by the exposure
    // here rather than in the prefilter is what lets the threshold be stated
    // against measured scene values instead of chasing the exposure slider.
    if (uniforms.bloomAmount > 0.0001) {
        let near = textureSampleLevel(bloomNear, bloomNearSampler, input.vUV, 0.0).rgb;
        let far = textureSampleLevel(bloomFar, bloomFarSampler, input.vUV, 0.0).rgb;
        // Weighted toward the *tight* level, which is the opposite of what an
        // atmosphere wants. The broad lobe of a glare pattern is forward
        // scattering off aerosols, and there are none out here; the nebula the
        // field drifts through is thin enough to be the minority term. What is
        // left is the instrument's own point spread, whose energy sits in the
        // core. A star that reads as a point with a hard little halo is a star;
        // the same star under a wide veil is a smudge.
        c += (near * 0.60 + far * 0.40) * uniforms.bloomAmount * uniforms.exposure;
    }

    // Stardust strands. Stated as a radiance and exposed like everything else,
    // so a grain going past the faceplate sits on the same scale as the grains
    // the wake is throwing three metres away — which is what they are.
    if (streak > 0.002) {
        let s = streakStrands(dFocus, radius, uniforms.time);
        c += STRAND_TINT * (s * streak * STRAND_RADIANCE * uniforms.exposure);
    }

    // Contrast about middle grey, applied in linear before the curve so it
    // pushes into the tonemapper's shoulder rather than clipping after it.
    if (abs(uniforms.contrast - 1.0) > 0.001) {
        c = 0.18 * pow(max(c / 0.18, vec3f(1e-5)), vec3f(uniforms.contrast));
    }

    // Every branch below returns *display-linear*, ready for one sRGB encode.
    var mapped: vec3f;
    if (uniforms.mode < 0.5) {
        // AgX's contrast polynomial already emits display-encoded values, so it
        // needs its EOTF (the 2.2 power) applied before the shared sRGB encode
        // at the bottom. Skipping that double-encodes the image: everything
        // lifts toward mid grey and the whole frame goes flat and milky —
        // which on a void is indistinguishable from "the shader is wrong".
        var v = agx(c);
        // Saturation is pushed further than a daylight grade would want, and for
        // a specific reason: AgX sheds chroma as it climbs toward the shoulder,
        // and everything coloured in this scene — the nebula's magenta, the
        // gold on the wake and the visor, the violet welling out of the dust —
        // is *above* middle grey rather than below it. Left at unity the band
        // resolves as a grey smear and the palette only survives in the
        // shadows, which is exactly backwards.
        v = agxLook(v, 1.28);
        mapped = pow(max(AGX_OUT * v, vec3f(0.0)), vec3f(2.2));
    } else if (uniforms.mode < 1.5) {
        // The Narkowicz fit is already display-linear.
        mapped = acesFitted(c);
    } else {
        mapped = clamp(c, vec3f(0.0), vec3f(1.0));
    }

    // Vignette, very slight — enough to keep the eye centred on a scene with no
    // UI to anchor it.
    if (uniforms.vignette > 0.001) {
        let d = length(input.vUV - vec2f(0.5)) * 1.414;
        mapped *= mix(1.0, smoothstep(1.05, 0.35, d), uniforms.vignette);
    }

    var outCol = linearToSrgb(mapped);

    // Grain, added after the encode so it reads evenly across the range instead
    // of vanishing in the shadows. It has a second job here that it did not have
    // on a bright field: the chain ends in an eight-bit buffer, and the void is a
    // very long, very shallow gradient from the galactic band down to nothing —
    // exactly the content that steps. This noise is the dither that keeps those
    // steps off the lattice, which is why it is not simply turned down to
    // nothing on a frame that is mostly black.
    if (uniforms.grainAmount > 0.0001) {
        let n = fract(sin(dot(input.vUV * vec2f(1920.0, 1080.0)
                + vec2f(uniforms.time * 91.7, uniforms.time * 43.3),
                vec2f(12.9898, 78.233))) * 43758.5453);
        outCol += (n - 0.5) * uniforms.grainAmount;
    }

    fragmentOutputs.color = vec4f(outCol, 1.0);
}
