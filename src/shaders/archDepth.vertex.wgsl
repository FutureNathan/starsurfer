// Cascade-depth vertex for the arch meshes: world-space vertices straight
// through the light's projection. The fragment stage is the shared
// terrainDepth one — there is nothing to discard on a rock.

attribute position: vec3f;

uniform lightViewProjection: mat4x4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = uniforms.lightViewProjection * vec4f(vertexInputs.position, 1.0);
}
