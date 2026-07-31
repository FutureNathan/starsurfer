// Martian suit shading: the ground's own light rules — same star, same SH
// ambient, same fog — over a green pressure suit, because a creature lit by
// different physics than the moon it stands on reads as a sticker. The one
// emissive liberty is the visor: a green-lit band across the front of the
// helmet, bright enough to be found by at night and to say "alive" by day,
// held under the bloom knee so eight of them cannot re-expose the frame.

#include<starNoise>
#include<starShading>
#include<starAtmosphere>

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform cameraPosition: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;
uniform hitFlash: f32;
uniform suitColor: vec3f;
uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vLocal: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let N = normalize(input.vNormal);
    let L = uniforms.sunDir;
    let world = input.vWorld;
    let lp = input.vLocal;

    // The suit wears whatever colour its owner was issued — rookie white
    // through veteran tiers, or crate gold — boots darker, pack darker
    // still. The HEAD is always the martian: green above the collar,
    // whatever the rank of the suit below it.
    var albedo = uniforms.suitColor;
    albedo *= mix(0.45, 1.0, smoothstep(0.12, 0.34, lp.y));
    if (lp.z < -0.16) { albedo *= 0.6; }
    let head = smoothstep(1.14, 1.24, lp.y);
    albedo = mix(albedo, vec3f(0.035, 0.150, 0.048), head);

    const INV_PI: f32 = 0.31830988618;
    let diff = wrapDiffuse(dot(N, L), 0.3);
    var col = albedo * INV_PI * uniforms.sunRadiance * diff;
    col += albedo * INV_PI * shIrradiance(N, uniforms.shR)
         * uniforms.ambientIntensity;

    // The visor: front of the helmet band, glowing from inside.
    let band = smoothstep(1.24, 1.32, lp.y) * (1.0 - smoothstep(1.46, 1.54, lp.y));
    let front = smoothstep(0.06, 0.19, lp.z);
    col += vec3f(0.30, 1.0, 0.42) * band * front * 5.0;

    // The hit-marker on the body itself: the whole suit floods red for the
    // flash's fraction of a second, emissive so it reads at any range in
    // any light — you know your shot landed because THEY know.
    let flash = clamp(uniforms.hitFlash, 0.0, 1.0);
    col = mix(col, vec3f(5.0, 0.30, 0.22), flash * 0.85);

    let dir = normalize(world - uniforms.cameraPosition);
    let t = aerialTransmittance(
        uniforms.cameraPosition, world,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart
    );
    let ext = clamp(1.0 - pow(t, uniforms.aerialStrength), 0.0, 1.0);
    let insc = aerialInscatterSky(
        skyLUT, skyLUTSampler, dir, L, uniforms.sunRadiance, ext
    );
    col = mix(col, insc, ext);

    fragmentOutputs.color = vec4f(col, 1.0);
}
