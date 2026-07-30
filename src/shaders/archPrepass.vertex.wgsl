// Depth-prepass vertex for the arch meshes. Registering them here is not
// optional polish: the speed-streak pass reads this depth to know what is
// background, and a tube roof missing from it would have star streaks
// smearing across the rock overhead at the exact moment of surfing under it.

attribute position: vec3f;

uniform viewProjection: mat4x4f;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vViewZ = vertexOutputs.position.w;
    vertexOutputs.vMask = 0.0;
}
