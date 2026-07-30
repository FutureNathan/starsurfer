// Bakes the macro landform (swells, the crater field, highland massifs) into a
// single-channel float texture covering the whole playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.

#include<starNoise>
#include<starTerrain>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.worldOrigin + input.vUV * uniforms.worldSize;

    var h = terrainMacro(p, uniforms.windAngle, uniforms.heightAmp);

    // A massif pushes the regolith up with it; the fines then creep back onto
    // the shallow faces, which the material resolves from the mask in the aux
    // bake.
    let rock = rockField(p, uniforms.windAngle);
    h += rock.x;

    fragmentOutputs.color = vec4f(h, rock.y, 0.0, 1.0);
}
