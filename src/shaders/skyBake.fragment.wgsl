// Bakes the deep-space backdrop into an equirectangular LUT.
// Re-run only when the star moves, never per frame.
//
// This shader runs at BOTH resolutions: 512x256 for the skybox and the specular
// mips, and 64x32 for the spherical-harmonic readback. That second one is the
// constraint that shapes everything here. At 64x32 a texel subtends five and a
// half degrees, so any high-frequency content — point stars especially — does
// not project to SH as structure. It projects as a randomly-tinted ambient that
// changes every time the star moves. Point stars and twinkle live in
// `sky.fragment.wgsl`, which is screen-only and gets `time` every frame; only
// smooth, low-frequency emission belongs in here, where it can light the scene.

#include<starNoise>
#include<starAtmosphere>

varying vUV: vec2f;

uniform sunDir: vec3f;
uniform sunIntensity: f32;
uniform groundBounce: vec3f;
uniform galaxyPole: vec3f;
uniform galaxyCore: vec3f;
uniform galaxyBand: f32;
uniform nebulaAmount: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = latLongToDir(input.vUV);
    let col = spaceSky(
        dir, uniforms.sunDir, uniforms.sunIntensity, uniforms.groundBounce,
        uniforms.galaxyPole, uniforms.galaxyCore,
        uniforms.galaxyBand, uniforms.nebulaAmount
    );

    // The star's own disc is deliberately absent. It is added in the skybox
    // shader instead, so that this LUT — which the SH projection integrates over
    // — never carries a five-order-of-magnitude spike that would blow out the fit.
    fragmentOutputs.color = vec4f(col, 1.0);
}
