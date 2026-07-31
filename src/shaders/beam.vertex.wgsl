// The laser beam: a unit cylinder stretched from muzzle to mark by its
// world matrix. The local position rides through for the radial falloff —
// the fragment turns the tube into a hot core with soft edges.

attribute position: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vLocal: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.position = uniforms.viewProjection * wp;
    vertexOutputs.vLocal = vertexInputs.position;
}
