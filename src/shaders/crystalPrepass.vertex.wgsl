// Depth-prepass vertex shader for the grown lattices. Same `crystalPoint` and
// the same growth curve as the beauty pass.
//
// The mask goes out at full strength, unconditionally, and this is the only
// caster on the ground that does. A grown facet is a real dielectric interface:
// the dust sea is matte at nine percent and reflects a *weight* proportional to
// how far the lattice has vitrified it, and the powers' plasma bodies have a
// graded boundary with almost no coherent reflection however bright they are.
// A prism is a mirror everywhere on it, so there is nothing to weight it by —
// which also means the reflection pass costs nothing on every frame where
// nobody has cast Star Crystal, since the mask is simply zero there.

#include<starNoise>
#include<starCrystal>

attribute position: vec3f;   // (crystal, vertex, unused)

uniform viewProjection: mat4x4f;

var crystalTex: texture_2d<f32>;
var crystalTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let v = i32(vertexInputs.position.y);
    let P = crystalPoint(crystalTex, i, v);
    let clip = uniforms.viewProjection * vec4f(P, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 1.0;
    vertexOutputs.position = clip;
}
