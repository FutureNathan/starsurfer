// The arch and tube-roof meshes — the landmark's built geometry.
//
// Vertices arrive already in world space (the mesh is static and singular, so
// a world matrix would multiply by identity sixty times a second for nothing).
// AO is baked per vertex at build time: the inside of a tube can precompute
// its own darkness, which is the entire lighting subtlety a cave needs at
// this size, for free.

attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;   // x: baked AO, y: unused

uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vAO: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vWorld = vertexInputs.position;
    vertexOutputs.vNormal = vertexInputs.normal;
    vertexOutputs.vAO = vertexInputs.uv.x;
}
