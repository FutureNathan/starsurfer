// -----------------------------------------------------------------------------
// Shell nap — the frayed edge of a thermal blanket where it is clamped at a seam.
//
// Each shell is a copy of the seam band's surface, pushed further out. This
// shader decides, per pixel per shell, whether a fibre is still present there.
// Two hashed quantities per fibre cell do all the work:
//
//   length   how far up the shell stack this fibre survives. Uniform-length
//            fibres read as a sponge; the variation is what makes it nap.
//   radius   the fibre's cross-section, tapering to nothing at its own tip, so
//            the silhouette is pointed rather than cut off flat.
//
// Lighting is deliberately not a surface BRDF. A fibre scatters forward
// strongly, wraps light most of the way round, and its roots are buried in
// shadow. Wrapped diffuse plus a strong transmission lobe plus depth-based
// occlusion gets all three, and white insulation against a low sun then does
// the thing white insulation does, which is glow around its edges.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowAtmosphere>

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

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;

/// Fibre cells per metre of surface. 420 is a 2.4 mm pitch.
uniform furDensity: f32;
uniform furColor: vec3f;

#include<snowShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let t = input.vAux.x;

    // ----------------------------------------------------------- fibre field
    let g = input.vUV * uniforms.furDensity;
    let cell = floor(g);
    let h = hash21(cell);
    let jitter = hash22(cell + vec2f(11.3, 5.7)) - 0.5;

    // How far up this fibre reaches. Cut early and often: a shell stack where
    // most fibres survive to the top is a solid shell with holes in it.
    let fibreLen = 0.30 + 0.70 * h;
    if (t > fibreLen) { discard; }

    // Distance to the fibre's own axis, in cell units.
    let d = length(fract(g) - 0.5 - jitter * 0.55);
    // Taper: full width at the root, a point at the tip.
    let taper = 1.0 - (t / fibreLen);
    let radius = 0.46 * (0.55 + 0.45 * hash21(cell + vec2f(3.1, 9.4))) * sqrt(max(taper, 0.0));
    if (d > radius) { discard; }

    // ------------------------------------------------------------- shading
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    var N = normalize(input.vNormal);
    if (dot(N, V) < 0.0) { N = -N; }

    let noiseRot = ign(input.position.xy) * 6.28318530718;
    var shadow = sunShadow(world, N, input.vViewDist, noiseRot);

    // Self-occlusion down the stack. Roots see almost no sky, tips see all of
    // it — this gradient is what gives a shell stack its depth, and without it
    // the seam reads as a flat white band.
    let depth = t / max(fibreLen, 1e-3);
    let selfAO = 0.16 + 0.84 * depth * depth;

    const INV_PI: f32 = 0.31830988618;
    let sun = uniforms.sunRadiance;
    let NdotL = dot(N, L);

    // Fibres wrap light almost all the way round.
    let diff = wrapDiffuse(NdotL, 0.65);
    var color = uniforms.furColor * INV_PI * sun * diff * shadow * selfAO;

    // Transmission — the term that makes a nap edge light up against a low sun.
    // Raised above unity, which a reflectance never should be but a *lobe* can:
    // the sun is the only strong source left in a space scene, and a seam that
    // does not catch it is a seam that vanishes into the suit.
    color += sun * uniforms.furColor * backScatter(N, L, V, 0.5, 3.0, 1.0)
           * 1.10 * mix(0.4, 1.0, shadow) * selfAO;

    // A dim, wide specular. Insulation is not glossy, but a completely matte
    // white reads as paper.
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let ds = distributionGGX(clamp(dot(N, H), 0.0, 1.0), 0.75);
        color += sun * ds * 0.05 * NdotL * shadow * selfAO;
    }

    // The ambient term does most of the work here. A daylight sky delivers an
    // order of magnitude more irradiance than a galactic band does, so the
    // multiplier has to make up the difference or the nap goes black wherever
    // the sun is not on it — which, at thirteen degrees, is most of the figure.
    let irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    color += uniforms.furColor * INV_PI * irradiance * selfAO * input.vAux.y * 2.2;

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, 1.0);
}
