// The depth prepass, shared by every caster that has nothing to discard.
//
// Linear view depth arrives as a varying rather than being reconstructed from
// `position.z`: for a perspective projection the clip-space w *is* the view-space
// z, so carrying it costs one interpolant and is exact, where linearising the
// depth buffer would spend a divide to recover a number the vertex stage already
// had.

varying vViewZ: f32;
/// Reflectivity: 0 matte, 1 mirror. Only the screen-space reflection pass reads
/// it, and it gates on anything at or above 0.02.
varying vMask: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(input.vViewZ, input.vMask, 0.0, 1.0);
}
