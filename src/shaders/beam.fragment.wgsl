// Additive, unlit, hot-cored. One solid rod of light: radiance well past
// the bloom knee at full intensity, so the beam carries its own glow, with
// a quadratic falloff to soft edges in the cylinder's own frame. Additive
// blending keeps it order-independent — a beam never has a wrong side.

uniform beamColor: vec3f;
uniform intensity: f32;

varying vLocal: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let r = clamp(length(input.vLocal.xz) * 2.0, 0.0, 1.0);
    let core = (1.0 - r * r);
    let col = uniforms.beamColor * uniforms.intensity * core * core;
    fragmentOutputs.color = vec4f(col, core);
}
