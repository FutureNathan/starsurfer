// Martian suit, vertex side: an ordinary world-transformed rigid mesh —
// Babylon binds `world` per clone, so eight martians share one material.
// The local position rides through to the fragment stage, which carves the
// visor band and the boot darkening out of it.

attribute position: vec3f;
attribute normal: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vLocal: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.position = uniforms.viewProjection * wp;
    vertexOutputs.vWorld = wp.xyz;
    vertexOutputs.vNormal = (uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz;
    vertexOutputs.vLocal = vertexInputs.position;
}
