// Shading for the arch and tube roofs: the ground's own material logic, cut
// to what basalt needs. Same star, same SH ambient, same fog — a built rock
// lit by its own rules is the matte-painting tell all over again.
//
// The albedo sits *below* the regolith: these are lava-tube walls, and
// mare basalt is the darkest common thing on the moon. The noise breaks the
// surface at two scales so the vault reads as rock rather than as poured
// concrete.

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
uniform dustEmission: vec3f;
uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vAO: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let N = normalize(input.vNormal);
    let L = uniforms.sunDir;
    let world = input.vWorld;
    let ao = input.vAO;

    var albedo = vec3f(0.082, 0.084, 0.088);
    let t1 = noise2(world.xz * 0.9 + world.y * 0.6) * 0.5 + 0.5;
    let t2 = noise2(vec2f(world.x + world.z, world.y) * 3.1) * 0.5 + 0.5;
    albedo *= 0.80 + 0.28 * t1 + 0.14 * (t2 - 0.5);

    const INV_PI: f32 = 0.31830988618;
    let diff = wrapDiffuse(dot(N, L), 0.25);
    var col = albedo * INV_PI * uniforms.sunRadiance * diff * ao;

    col += albedo * INV_PI * shIrradiance(N, uniforms.shR)
         * uniforms.ambientIntensity * ao;

    // The ground fill glows faintly into the tube — without it a vault in
    // shadow is a black hole in the frame, and with much more of it the cave
    // stops being dark, which is its whole atmosphere.
    col += uniforms.dustEmission * 0.30 * ao;

    let V = -normalize(world - uniforms.cameraPosition);
    let dir = -V;
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
