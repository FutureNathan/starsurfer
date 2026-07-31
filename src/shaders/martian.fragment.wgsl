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

    // Suit green, boots and gloves darker, pack darker still.
    var albedo = vec3f(0.030, 0.115, 0.040);
    albedo *= mix(0.45, 1.0, smoothstep(0.12, 0.34, lp.y));
    if (lp.z < -0.16) { albedo *= 0.6; }

    const INV_PI: f32 = 0.31830988618;
    let diff = wrapDiffuse(dot(N, L), 0.3);
    var col = albedo * INV_PI * uniforms.sunRadiance * diff;
    col += albedo * INV_PI * shIrradiance(N, uniforms.shR)
         * uniforms.ambientIntensity;

    // The visor: front of the helmet band, glowing from inside.
    let band = smoothstep(1.24, 1.32, lp.y) * (1.0 - smoothstep(1.46, 1.54, lp.y));
    let front = smoothstep(0.06, 0.19, lp.z);
    col += vec3f(0.30, 1.0, 0.42) * band * front * 5.0;

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
