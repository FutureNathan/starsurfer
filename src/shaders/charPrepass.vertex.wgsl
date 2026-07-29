// Depth-prepass vertex shader for the skinned body. Same skinning path as
// char.vertex.wgsl and charDepth.vertex.wgsl, from the same include.
//
// It also carries `aux`, which nothing else in a depth pass needs, so that the
// faceplate can declare itself a mirror to the reflection pass. That is the
// entire cost of screen-space reflections on the one surface here that is
// actually reflective: one attribute and one comparison.

#include<snowCharSkin>

attribute position: vec3f;
attribute aux: vec2f;        // (material id, baked occlusion)
attribute boneIdx: vec4f;
attribute boneWt: vec4f;

uniform viewProjection: mat4x4f;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

/// Material slot 2 is the gold faceplate. See `M_VISOR` in character/build.js.
const VISOR_SLOT: i32 = 2;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skinPoint(charTex, vertexInputs.boneIdx, vertexInputs.boneWt, vertexInputs.position);
    let clip = uniforms.viewProjection * vec4f(world, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = select(0.0, 1.0, i32(vertexInputs.aux.x + 0.5) == VISOR_SLOT);
    vertexOutputs.position = clip;
}
